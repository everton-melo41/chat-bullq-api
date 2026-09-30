import { IdempotencyService } from './idempotency.service';

describe('mutex renovável de conversas', () => {
  afterEach(() => jest.useRealTimers());
  it('renova somente sua posse e libera o mutex após toda a execução', async () => {
    jest.useFakeTimers();
    const service: any = Object.create(IdempotencyService.prototype);
    let finish!: () => void;
    const work = new Promise<void>(resolve => { finish = resolve; });
    Object.assign(service, { acquireLock: jest.fn().mockResolvedValue('token'), releaseLock: jest.fn(), redis: { eval: jest.fn().mockResolvedValue(1) }, logger: { error: jest.fn() } });
    const result = service.withLock('ai-run-conv', () => work, { ttlMs: 3000, renew: true });
    await jest.advanceTimersByTimeAsync(2100);
    expect(service.redis.eval).toHaveBeenCalledTimes(2);
    expect(service.redis.eval).toHaveBeenCalledWith(expect.stringContaining('pexpire'), 1, 'lock:ai-run-conv', 'token', 3000);
    expect(service.releaseLock).not.toHaveBeenCalled();
    finish(); await result;
    expect(service.releaseLock).toHaveBeenCalledWith('ai-run-conv', 'token');
    await jest.advanceTimersByTimeAsync(3000);
    expect(service.redis.eval).toHaveBeenCalledTimes(2);
  });
});
