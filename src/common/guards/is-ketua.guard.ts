import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GroupMember } from '../../modules/groups/entities/group-member.entity';
import { Role } from '../../modules/users/entities/user.entity';

@Injectable()
export class IsKetuaGuard implements CanActivate {
  constructor(
    @InjectRepository(GroupMember)
    private readonly memberRepo: Repository<GroupMember>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) throw new ForbiddenException('Akses ditolak');

    // Admin bypass
    if (user.role === Role.ADMIN) return true;

    const groupId = request.params.groupId;
    if (!groupId) throw new ForbiddenException('Group ID tidak ditemukan');

    const member = await this.memberRepo.findOne({
      where: { group_id: groupId, user_id: user.id },
    });

    if (!member || !member.is_ketua) {
      throw new ForbiddenException('Hanya ketua grup yang dapat melakukan aksi ini');
    }

    return true;
  }
}
