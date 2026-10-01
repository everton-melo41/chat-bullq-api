import { chunkKnowledge } from './chunking';
import { KnowledgeService } from './knowledge.service';
import { VectorStoreService } from '../rag/vector-store.service';
import { knowledgeBinding } from './knowledge.binding';
import { MentionsService } from '../mentions/mentions.service';

describe('knowledge chunking', () => {
  it('preserves section hierarchy and overlap', () => {
    const text = Array.from({ length: 2600 }, (_, i) => String(i % 10)).join('');
    const chunks = chunkKnowledge(`# Manual\n## Direitos\n${text}`);
    expect(chunks[1].section).toBe('Manual > Direitos');
    const body = chunks.slice(1).map(c => c.content.split('\n\n')[1]);
    expect(body[0].slice(-150)).toBe(body[1].slice(0, 150));
    expect(body[0] + body.slice(1).map(s => s.slice(150)).join('')).toBe(text);
    expect(body.every(s => s.length <= 1200)).toBe(true);
  });
  it('keeps fenced headings as data, plain text and empty input', () => {
    expect(chunkKnowledge('')).toEqual([]);
    expect(chunkKnowledge('texto')).toEqual([{ section: '', content: 'texto' }]);
    expect(chunkKnowledge('# A\n```md\n# falso\n```\ntexto')).toHaveLength(1);
  });
});

describe('knowledge isolation and search', () => {
  let prisma: any, embeddings: any, vectors: any, queue: any, service: KnowledgeService;
  const doc = { id: 'd1', title: 'Manual', updatedAt: new Date(0), content: '# Seção\nTexto', organizationId: 'o1', status: 'PROCESSING' };
  beforeEach(() => {
    prisma = { aiAgent: { findFirst: jest.fn().mockResolvedValue({ id: 'a1' }) }, knowledgeDocument: { findMany: jest.fn().mockResolvedValue([doc]), findFirst: jest.fn().mockResolvedValue(doc), update: jest.fn(), updateMany: jest.fn() }, knowledgeDocumentAgent: { deleteMany: jest.fn(), createMany: jest.fn() }, $queryRaw: jest.fn(), $executeRawUnsafe: jest.fn() };
    prisma.$transaction = jest.fn((fn: any) => fn(prisma));
    embeddings = { embed: jest.fn().mockResolvedValue({ vector: [1, 0] }), embedBatch: jest.fn().mockResolvedValue([{ vector: [1, 0] }]) };
    vectors = { search: jest.fn().mockResolvedValue([{ entry: { ownerId: 'd1', content: 'trecho', metadata: { section: 'Seção' } }, score: .9 }]) };
    queue = { add: jest.fn() };
    service = new KnowledgeService(prisma, embeddings, vectors, queue);
  });
  it('filters organization, agent and ready documents before searching the allowed owner IDs', async () => {
    const result = await service.search('o1', 'a1', 'direitos?');
    expect(prisma.aiAgent.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'a1', organizationId: 'o1', deletedAt: null } }));
    expect(prisma.knowledgeDocument.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'o1', status: 'READY', agents: { some: { agentId: 'a1', agent: { organizationId: 'o1', deletedAt: null } } } } }));
    expect(vectors.search).toHaveBeenCalledWith([1, 0], { ownerType: 'knowledge', ownerIds: ['d1'] }, 5, -1);
    expect(result.excerpts[0]).toMatchObject({ type: 'material de referência', title: 'Manual', section: 'Seção', score: .9 });
  });
  it('does not embed or search without linked ready documents', async () => {
    prisma.knowledgeDocument.findMany.mockResolvedValue([]);
    expect((await service.search('o1', 'a1', 'pergunta')).message).toContain('não possui');
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(vectors.search).not.toHaveBeenCalled();
  });
  it('rejects a foreign agent and foreign document IDs before changing links', async () => {
    prisma.aiAgent.findFirst.mockResolvedValueOnce(null);
    await expect(service.linked('o2', 'a1')).rejects.toThrow('Agente não encontrado');
    prisma.knowledgeDocument.findMany.mockResolvedValue([]);
    await expect(service.link('o1', 'a1', ['foreign'])).rejects.toThrow('Documento não pertence');
    expect(prisma.knowledgeDocumentAgent.deleteMany).not.toHaveBeenCalled();
  });
  it('discards results when links are revoked during search', async () => {
    prisma.knowledgeDocument.findMany.mockResolvedValueOnce([doc]).mockResolvedValueOnce([]);
    expect((await service.search('o1', 'a1', 'pergunta')).excerpts).toEqual([]);
  });
  it('replaces links atomically with unique IDs', async () => {
    await service.link('o1', 'a1', ['d1', 'd1']);
    expect(prisma.knowledgeDocumentAgent.createMany).toHaveBeenCalledWith({ data: [{ documentId: 'd1', agentId: 'a1' }] });
  });
  it('indexes batches with metadata and replaces old vectors before READY', async () => {
    await service.index('d1', 'o1');
    expect(embeddings.embedBatch).toHaveBeenCalledWith(['Seção\n\nTexto']);
    expect(prisma.$executeRawUnsafe.mock.calls[0]).toEqual(['DELETE FROM ai_vector_entries WHERE owner_type = $1 AND owner_id = $2', 'knowledge', 'd1']);
    expect(prisma.$executeRawUnsafe.mock.calls[1]).toContain(JSON.stringify({ title: 'Manual', section: 'Seção', organizationId: 'o1' }));
    expect(prisma.knowledgeDocument.update).toHaveBeenCalledWith({ where: { id: 'd1' }, data: { status: 'READY', error: null, chunkCount: 1 } });
  });
  it('does not publish stale vectors when edited while embedding', async () => {
    prisma.knowledgeDocument.findFirst.mockResolvedValueOnce(doc).mockResolvedValueOnce({ ...doc, updatedAt: new Date(100) });
    await service.index('d1', 'o1');
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
  it('records failed indexing without overwriting another version', async () => {
    embeddings.embedBatch.mockRejectedValue(new Error('unavailable'));
    await expect(service.index('d1', 'o1')).rejects.toThrow();
    expect(prisma.knowledgeDocument.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'd1', organizationId: 'o1', updatedAt: doc.updatedAt }, data: expect.objectContaining({ status: 'FAILED' }) }));
  });
  it('rejects oversize and empty documents before persistence', async () => {
    await expect(service.update('o1', 'd1', 'Título', 'a'.repeat(200001))).rejects.toThrow('200 mil');
    await expect(service.update('o1', 'd1', 'Título', ' ')).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('knowledge vector predicate', () => {
  it('uses parameterized owner IDs and cosine ordering; empty allowlist searches nothing', async () => {
    const prisma: any = { $queryRawUnsafe: jest.fn().mockResolvedValue([]) };
    const store = new VectorStoreService(prisma);
    await store.search([1, 0], { ownerType: 'knowledge', ownerIds: ["x' OR TRUE"] }, 5, -1);
    const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('owner_id = ANY($4::text[])');
    expect(sql).toContain('ORDER BY embedding <=> $1::vector ASC');
    expect(sql).not.toContain("x' OR TRUE");
    expect(params).toEqual(['[1,0]', 5, 'knowledge', ["x' OR TRUE"]]);
    prisma.$queryRawUnsafe.mockClear();
    expect(await store.search([1], { ownerIds: [] })).toEqual([]);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
  it('accepts the explicit library mention', async () => {
    const model = { findMany: jest.fn().mockResolvedValue([]) };
    const mentions = new MentionsService({ aiAgent: model, tag: model, department: model, pipelineStage: model, agentMedia: model } as any);
    expect((await mentions.compile('org', '@[biblioteca](action:library)')).bindings).toEqual([knowledgeBinding]);
  });
});
