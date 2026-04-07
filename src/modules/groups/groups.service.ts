import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not } from 'typeorm';
import { Group, GroupStatus } from './entities/group.entity';
import { GroupMember } from './entities/group-member.entity';
import { Ticket, TicketStatus } from '../tickets/entities/ticket.entity';
import { Payment } from '../payments/entities/payment.entity';
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { SetKetuaDto } from './dto/set-ketua.dto';
import { ActivateGroupDto } from './dto/activate-group.dto';
import { DrawsService } from '../draws/draws.service';
import { ActivityLogService } from '../admin/services/activity-log.service';
import { ActivityAction, ActivityTargetType } from '../admin/entities/activity-log.entity';

const ELIGIBLE_STATUSES = [TicketStatus.PAID, TicketStatus.ACTIVE, TicketStatus.WON];

@Injectable()
export class GroupsService {
  constructor(
    @InjectRepository(Group)
    private readonly groupRepo: Repository<Group>,
    @InjectRepository(GroupMember)
    private readonly memberRepo: Repository<GroupMember>,
    @InjectRepository(Ticket)
    private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    @Inject(forwardRef(() => DrawsService))
    private readonly drawsService: DrawsService,
    @Inject(forwardRef(() => ActivityLogService))
    private readonly activityLogService: ActivityLogService,
  ) {}

  async createGroup(dto: CreateGroupDto, userId: string): Promise<Group> {
    const group = this.groupRepo.create({
      name: dto.name,
      max_members: dto.max_members || 12,
      ticket_price: dto.ticket_price || 0,
      prize: dto.prize || null,
      icon: dto.icon || 'smartphone',
      created_by: userId,
      status: GroupStatus.PENDING,
    });
    const saved = await this.groupRepo.save(group);

    await this.activityLogService.log({
      actorId: userId,
      action: ActivityAction.GROUP_CREATED,
      targetType: ActivityTargetType.GROUP,
      targetId: saved.id,
      metadata: { group_name: saved.name },
    });

    return saved;
  }

  async findAll(showHidden = false): Promise<any[]> {
    const where = showHidden ? {} : { is_hidden: false };
    const groups = await this.groupRepo.find({ where, relations: ['members', 'members.user'] });

    // Batch query slot counts (eligible tickets only: paid, active, won)
    const slotCountsRaw = await this.ticketRepo
      .createQueryBuilder('t')
      .select('t.group_id', 'group_id')
      .addSelect('COUNT(*)', 'count')
      .where('t.status IN (:...statuses)', { statuses: ELIGIBLE_STATUSES })
      .groupBy('t.group_id')
      .getRawMany();
    const slotMap = new Map(slotCountsRaw.map((r) => [r.group_id, parseInt(r.count, 10)]));

    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      status: g.status,
      is_hidden: g.is_hidden,
      icon: g.icon,
      max_members: g.max_members,
      max_slots: g.max_members,
      ticket_price: g.ticket_price,
      prize: g.prize,
      created_by: g.created_by,
      next_draw_date: g.next_draw_date,
      activated_at: g.activated_at,
      created_at: g.created_at,
      updated_at: g.updated_at,
      member_count: g.members.length,
      slot_count: slotMap.get(g.id) ?? 0,
      members: g.members.map((m) => ({
        id: m.id,
        is_ketua: m.is_ketua,
        joined_at: m.joined_at,
        user: {
          id: m.user.id,
          username: m.user.username,
          name: m.user.name,
          role: m.user.role,
        },
      })),
    }));
  }

  async findOne(id: string): Promise<any> {
    const group = await this.groupRepo.findOne({
      where: { id },
      relations: ['members', 'members.user'],
    });
    if (!group) throw new NotFoundException(`Group ${id} not found`);

    const [slotCount, groupTickets] = await Promise.all([
      this.ticketRepo.count({
        where: { group_id: id, status: In(ELIGIBLE_STATUSES) },
      }),
      this.ticketRepo.find({
        where: { group_id: id, status: Not(TicketStatus.CANCELLED) },
        order: { created_at: 'ASC' },
      }),
    ]);

    // Group tickets by user_id
    const ticketsByUser = new Map<string, typeof groupTickets>();
    groupTickets.forEach((t) => {
      if (!ticketsByUser.has(t.user_id)) ticketsByUser.set(t.user_id, []);
      ticketsByUser.get(t.user_id)!.push(t);
    });

    return {
      id: group.id,
      name: group.name,
      status: group.status,
      is_hidden: group.is_hidden,
      icon: group.icon,
      max_members: group.max_members,
      max_slots: group.max_members,
      ticket_price: group.ticket_price,
      prize: group.prize,
      created_by: group.created_by,
      next_draw_date: group.next_draw_date,
      activated_at: group.activated_at,
      created_at: group.created_at,
      updated_at: group.updated_at,
      member_count: group.members.length,
      slot_count: slotCount,
      members: group.members.map((m) => {
        const userTickets = ticketsByUser.get(m.user_id) ?? [];
        return {
          id: m.id,
          is_ketua: m.is_ketua,
          joined_at: m.joined_at,
          ticket_count: userTickets.length,
          tickets: userTickets.map((t) => ({
            id: t.id,
            ticket_code: t.ticket_code,
            slot_number: t.slot_number,
            status: t.status,
            created_at: t.created_at,
          })),
          user: {
            id: m.user.id,
            username: m.user.username,
            name: m.user.name,
            role: m.user.role,
          },
        };
      }),
    };
  }

  async findByMember(userId: string): Promise<any[]> {
    const members = await this.memberRepo.find({
      where: { user_id: userId },
      relations: ['group', 'group.members', 'group.members.user'],
      order: { joined_at: 'DESC' },
    });

    // Batch query slot counts
    const groupIds = members.map((m) => m.group.id);
    let slotMap = new Map<string, number>();
    if (groupIds.length > 0) {
      const slotCountsRaw = await this.ticketRepo
        .createQueryBuilder('t')
        .select('t.group_id', 'group_id')
        .addSelect('COUNT(*)', 'count')
        .where('t.group_id IN (:...ids)', { ids: groupIds })
        .andWhere('t.status IN (:...statuses)', { statuses: ELIGIBLE_STATUSES })
        .groupBy('t.group_id')
        .getRawMany();
      slotMap = new Map(slotCountsRaw.map((r) => [r.group_id, parseInt(r.count, 10)]));
    }

    return members.map((m) => ({
      id: m.group.id,
      name: m.group.name,
      status: m.group.status,
      icon: m.group.icon,
      max_members: m.group.max_members,
      max_slots: m.group.max_members,
      ticket_price: m.group.ticket_price,
      prize: m.group.prize,
      created_by: m.group.created_by,
      next_draw_date: m.group.next_draw_date,
      activated_at: m.group.activated_at,
      created_at: m.group.created_at,
      updated_at: m.group.updated_at,
      member_count: m.group.members.length,
      slot_count: slotMap.get(m.group.id) ?? 0,
      is_ketua: m.is_ketua,
      joined_at: m.joined_at,
      members: m.group.members.map((gm) => ({
        id: gm.id,
        is_ketua: gm.is_ketua,
        joined_at: gm.joined_at,
        user: {
          id: gm.user.id,
          username: gm.user.username,
          name: gm.user.name,
          role: gm.user.role,
        },
      })),
    }));
  }

  async joinGroup(groupId: string, userId: string): Promise<any> {
    const group = await this.groupRepo.findOne({ where: { id: groupId } });
    if (!group) {
      throw new NotFoundException(`Group ${groupId} not found`);
    }

    if (group.status === GroupStatus.ACTIVE) {
      throw new BadRequestException('Group is already active, cannot join');
    }

    // Cek kapasitas berdasarkan slot (ticket count)
    const slotCount = await this.ticketRepo.count({
      where: { group_id: groupId, status: In(ELIGIBLE_STATUSES) },
    });
    if (slotCount >= group.max_members) {
      throw new BadRequestException('Group is already full');
    }

    const existing = await this.memberRepo.findOne({
      where: { group_id: groupId, user_id: userId },
    });
    if (existing) {
      throw new ConflictException('User is already a member of this group');
    }

    const member = this.memberRepo.create({
      group_id: groupId,
      user_id: userId,
    });
    const saved = await this.memberRepo.save(member);

    // Load relations for nested response
    const memberWithRelations = await this.memberRepo.findOne({
      where: { id: saved.id },
      relations: ['group', 'user'],
    });

    if (!memberWithRelations) {
      throw new NotFoundException('Member not found after creation');
    }

    await this.activityLogService.log({
      actorId: userId,
      action: ActivityAction.MEMBER_JOINED,
      targetType: ActivityTargetType.GROUP,
      targetId: groupId,
      metadata: {
        group_name: memberWithRelations.group.name,
        member_name: memberWithRelations.user.name,
      },
    });

    return {
      id: memberWithRelations.id,
      joined_at: memberWithRelations.joined_at,
      group: {
        id: memberWithRelations.group.id,
        name: memberWithRelations.group.name,
        status: memberWithRelations.group.status,
      },
      user: {
        id: memberWithRelations.user.id,
        username: memberWithRelations.user.username,
        name: memberWithRelations.user.name,
      },
    };
  }

  async setKetua(
    groupId: string,
    memberId: string,
    dto: SetKetuaDto,
    adminId: string,
  ): Promise<GroupMember> {
    const member = await this.memberRepo.findOne({
      where: { id: memberId, group_id: groupId },
      relations: ['user', 'group'],
    });
    if (!member) {
      throw new NotFoundException(
        `Member ${memberId} not found in group ${groupId}`,
      );
    }

    // Jika set sebagai ketua, unset ketua lain di grup ini
    // Jika unset (is_ketua: false), langsung unset member ini saja
    if (dto.is_ketua) {
      await this.memberRepo.update(
        { group_id: groupId, is_ketua: true },
        { is_ketua: false },
      );
    }

    member.is_ketua = dto.is_ketua;
    const saved = await this.memberRepo.save(member);

    await this.activityLogService.log({
      actorId: adminId,
      action: ActivityAction.KETUA_SET,
      targetType: ActivityTargetType.GROUP,
      targetId: groupId,
      metadata: {
        group_name: member.group.name,
        ketua_name: member.user.name,
        is_ketua: dto.is_ketua,
      },
    });

    return saved;
  }

  async updateGroup(groupId: string, dto: UpdateGroupDto): Promise<any> {
    const group = await this.groupRepo.findOne({ where: { id: groupId } });
    if (!group) {
      throw new NotFoundException(`Group ${groupId} not found`);
    }

    const updateData: any = {};
    const changedFields: string[] = [];

    if (dto.name) {
      updateData.name = dto.name;
      changedFields.push('name');
    }
    if (dto.max_members) {
      updateData.max_members = dto.max_members;
      changedFields.push('max_members');
    }
    if (dto.next_draw_date) {
      updateData.next_draw_date = new Date(dto.next_draw_date);
      changedFields.push('next_draw_date');
    }
    if (dto.ticket_price !== undefined) {
      updateData.ticket_price = dto.ticket_price;
      changedFields.push('ticket_price');
    }
    if (dto.prize !== undefined) {
      updateData.prize = dto.prize;
      changedFields.push('prize');
    }
    if (dto.icon !== undefined) {
      updateData.icon = dto.icon;
      changedFields.push('icon');
    }
    if (dto.is_hidden !== undefined) {
      updateData.is_hidden = dto.is_hidden;
      changedFields.push('is_hidden');
    }

    await this.groupRepo.update(groupId, updateData);

    if (dto.next_draw_date) {
      await this.drawsService.syncScheduledDrawDate(
        groupId,
        updateData.next_draw_date,
      );
    }

    if (changedFields.length > 0) {
      await this.activityLogService.log({
        actorId: group.created_by,
        action: ActivityAction.GROUP_UPDATED,
        targetType: ActivityTargetType.GROUP,
        targetId: groupId,
        metadata: {
          group_name: updateData.name || group.name,
          changed_fields: changedFields,
        },
      });
    }

    return this.findOne(groupId);
  }

  async deleteGroup(groupId: string): Promise<{ message: string }> {
    const group = await this.groupRepo.findOne({ where: { id: groupId } });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);

    // Ambil semua ticket di grup ini
    const tickets = await this.ticketRepo.find({ where: { group_id: groupId } });
    const ticketIds = tickets.map((t) => t.id);

    // Hapus payments yang terkait ticket grup ini
    if (ticketIds.length > 0) {
      await this.paymentRepo
        .createQueryBuilder()
        .delete()
        .where('ticket_id IN (:...ids)', { ids: ticketIds })
        .execute();
    }

    // Hapus tickets
    if (tickets.length > 0) {
      await this.ticketRepo.remove(tickets);
    }

    // Hapus group members (sudah cascade di entity, tapi eksplisit lebih aman)
    await this.memberRepo.delete({ group_id: groupId });

    // Hapus group
    await this.groupRepo.remove(group);

    return { message: 'Group deleted successfully' };
  }

  async activateGroup(groupId: string, dto: ActivateGroupDto): Promise<Group> {
    const group = await this.findOne(groupId);

    const ketua = group.members.find((m) => m.is_ketua === true);
    if (!ketua) {
      throw new BadRequestException(
        'Group must have a ketua before activation',
      );
    }

    const activatedAt = new Date();
    const nextDrawDate = new Date(dto.next_draw_date);
    const scheduledDraw = await this.drawsService.ensureScheduledDraw(
      groupId,
      nextDrawDate,
    );

    if (!scheduledDraw.winner_user_id || !scheduledDraw.winner_ticket_id) {
      throw new BadRequestException(
        'Group must have a winner before activation',
      );
    }

    await this.groupRepo.update(groupId, {
      status: GroupStatus.ACTIVE,
      next_draw_date: nextDrawDate,
      activated_at: activatedAt,
    });

    await this.activityLogService.log({
      actorId: group.created_by,
      action: ActivityAction.GROUP_ACTIVATED,
      targetType: ActivityTargetType.GROUP,
      targetId: groupId,
      metadata: {
        group_name: group.name,
        draw_date: nextDrawDate.toISOString().split('T')[0],
      },
    });

    return this.findOne(groupId);
  }
}
