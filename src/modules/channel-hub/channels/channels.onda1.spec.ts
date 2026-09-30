import { BadRequestException } from '@nestjs/common';
import { ChannelsService } from './channels.service';

describe('Channel default department validation', () => {
  function setup(found: unknown) {
    return Object.assign(Object.create(ChannelsService.prototype), {
      findOne: jest.fn(),
      prisma: { department: { findFirst: jest.fn().mockResolvedValue(found) } },
      repository: { update: jest.fn() },
    });
  }
  it('rejects departments outside this channel or organization', async () => {
    const service = setup(null);
    await expect(service.update('channel', 'org', { defaultDepartmentId: 'invalid' })).rejects.toBeInstanceOf(BadRequestException);
    expect(service.prisma.department.findFirst).toHaveBeenCalledWith({ where: { id: 'invalid', organizationId: 'org', channelId: 'channel', deletedAt: null } });
    expect(service.repository.update).not.toHaveBeenCalled();
  });
  it('saves a matching default and permits clearing it', async () => {
    const service = setup({ id: 'dept' });
    await service.update('channel', 'org', { defaultDepartmentId: 'dept' });
    await service.update('channel', 'org', { defaultDepartmentId: null });
    expect(service.repository.update).toHaveBeenNthCalledWith(1, 'channel', { defaultDepartmentId: 'dept' });
    expect(service.repository.update).toHaveBeenNthCalledWith(2, 'channel', { defaultDepartmentId: null });
  });
});
