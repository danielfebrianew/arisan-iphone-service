import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { Group, GroupStatus } from '../../groups/entities/group.entity';
import { GroupMember } from '../../groups/entities/group-member.entity';
import { Payment, PaymentStatus } from '../../payments/entities/payment.entity';
import { Ticket, TicketStatus } from '../../tickets/entities/ticket.entity';
import { ActivityLogService } from './activity-log.service';
import { ActivityAction, ActivityTargetType } from '../entities/activity-log.entity';

const SLOT_OCCUPYING_STATUSES = [
  TicketStatus.PAID,
  TicketStatus.ACTIVE,
  TicketStatus.WON,
];

export interface StatsResponse {
  groups: {
    total: number;
    by_status: {
      pending: number;
      waiting: number;
      full: number;
      active: number;
      completed: number;
    };
  };
  members: {
    total_users: number;
    total_slots_filled: number;
  };
  payments: {
    total_verified: number;
    pending_review: number;
  };
  action_items: {
    groups_without_ketua: number;
    groups_full_not_activated: number;
    payments_pending: number;
    tickets_expirable: number;
  };
}

@Injectable()
export class AdminStatsService {
  constructor(
    @InjectRepository(Group)
    private readonly groupRepo: Repository<Group>,
    @InjectRepository(GroupMember)
    private readonly memberRepo: Repository<GroupMember>,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    @InjectRepository(Ticket)
    private readonly ticketRepo: Repository<Ticket>,
    @Inject(forwardRef(() => ActivityLogService))
    private readonly activityLogService: ActivityLogService,
  ) {}

  async getStats(): Promise<StatsResponse> {
    // Get all groups count
    const totalGroups = await this.groupRepo.count();

    // Get groups by status
    const groupsByStatus = await this.groupRepo
      .createQueryBuilder('g')
      .select('g.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('g.status')
      .getRawMany();

    const statusCounts = {
      pending: 0,
      waiting: 0,
      full: 0,
      active: 0,
      completed: 0,
    };

    groupsByStatus.forEach((row) => {
      if (row.status in statusCounts) {
        statusCounts[row.status] = parseInt(row.count, 10);
      }
    });

    // Get total unique users who joined at least 1 group
    const totalUniqueUsers = await this.memberRepo
      .createQueryBuilder('gm')
      .select('COUNT(DISTINCT gm.user_id)', 'count')
      .getRawOne();

    // Get total slots filled (eligible tickets only: paid, active, won)
    const totalSlotsFilled = await this.ticketRepo.count({
      where: { status: In([TicketStatus.PAID, TicketStatus.ACTIVE, TicketStatus.WON]) },
    });

    // Get total verified payments
    const verifiedPayments = await this.paymentRepo
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.amount), 0)', 'total')
      .where('p.status = :status', { status: PaymentStatus.VERIFIED })
      .getRawOne();

    // Get pending payments count
    const pendingPayments = await this.paymentRepo.count({
      where: { status: PaymentStatus.PENDING },
    });

    // Get groups without ketua (excluding completed groups)
    const groupsWithoutKetua = await this.groupRepo
      .createQueryBuilder('g')
      .leftJoin(
        (qb) =>
          qb
            .select('DISTINCT gm.group_id')
            .from(GroupMember, 'gm')
            .where('gm.is_ketua = :isKetua', { isKetua: true }),
        'gm_ketua',
        'gm_ketua.group_id = g.id',
      )
      .where('gm_ketua.group_id IS NULL')
      .andWhere('g.status != :completed', { completed: GroupStatus.COMPLETED })
      .getCount();

    // Get groups that are full but not activated
    const groupsFullNotActivated = await this.groupRepo.count({
      where: {
        status: GroupStatus.FULL,
      },
    });

    // Get tickets pending_payment older than 24 hours (expirable by admin)
    const ticketsExpirable = await this.ticketRepo
      .createQueryBuilder('t')
      .where('t.status = :status', { status: TicketStatus.PENDING_PAYMENT })
      .andWhere('t.created_at < :cutoff', { cutoff: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .getCount();

    return {
      groups: {
        total: totalGroups,
        by_status: statusCounts,
      },
      members: {
        total_users: parseInt(totalUniqueUsers.count || 0, 10),
        total_slots_filled: totalSlotsFilled,
      },
      payments: {
        total_verified: parseInt(verifiedPayments.total || 0, 10),
        pending_review: pendingPayments,
      },
      action_items: {
        groups_without_ketua: groupsWithoutKetua,
        groups_full_not_activated: groupsFullNotActivated,
        payments_pending: pendingPayments,
        tickets_expirable: ticketsExpirable,
      },
    };
  }

  async expireTicket(ticketId: string, adminId: string): Promise<any> {
    const ticket = await this.ticketRepo.findOne({
      where: { id: ticketId },
      relations: ['user', 'group'],
    });
    if (!ticket) throw new NotFoundException(`Ticket ${ticketId} not found`);

    if (ticket.status !== TicketStatus.PENDING_PAYMENT) {
      throw new BadRequestException(
        `Ticket status "${ticket.status}" tidak bisa di-expire. Hanya ticket pending_payment yang bisa di-expire.`,
      );
    }

    // Cek apakah ada payment pending untuk ticket ini
    const pendingPayment = await this.paymentRepo.findOne({
      where: { ticket_id: ticketId, status: PaymentStatus.PENDING },
    });
    if (pendingPayment) {
      throw new BadRequestException(
        'Ticket ini masih punya bukti bayar yang menunggu verifikasi. Reject payment dulu sebelum expire ticket.',
      );
    }

    // Warning jika belum 24 jam
    const hoursSinceCreated = (Date.now() - new Date(ticket.created_at).getTime()) / (1000 * 60 * 60);
    const warning = hoursSinceCreated < 24
      ? 'Ticket di-expire sebelum 24 jam (force expire oleh admin)'
      : null;

    ticket.status = TicketStatus.EXPIRED;
    await this.ticketRepo.save(ticket);

    // Rollback status grup jika sebelumnya FULL tapi slot sudah berkurang
    if (ticket.group.status === GroupStatus.FULL) {
      const slotCount = await this.ticketRepo.count({
        where: { group_id: ticket.group_id, status: In(SLOT_OCCUPYING_STATUSES) },
      });
      if (slotCount < ticket.group.max_members) {
        await this.groupRepo.update(ticket.group_id, { status: GroupStatus.PENDING });
      }
    }

    await this.activityLogService.log({
      actorId: adminId,
      action: ActivityAction.TICKET_EXPIRED,
      targetType: ActivityTargetType.TICKET,
      targetId: ticketId,
      metadata: {
        ticket_code: ticket.ticket_code,
        group_name: ticket.group.name,
        member_name: ticket.user.name,
        force_expired: hoursSinceCreated < 24,
      },
    });

    return {
      id: ticket.id,
      ticket_code: ticket.ticket_code,
      status: ticket.status,
      created_at: ticket.created_at,
      warning,
      group: {
        id: ticket.group.id,
        name: ticket.group.name,
      },
      user: {
        id: ticket.user.id,
        username: ticket.user.username,
        name: ticket.user.name,
      },
    };
  }

  async syncGroupStatus(groupId: string): Promise<any> {
    const group = await this.groupRepo.findOne({ where: { id: groupId } });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);

    // Jangan sync grup yang sudah active atau completed
    if (group.status === GroupStatus.ACTIVE || group.status === GroupStatus.COMPLETED) {
      return {
        id: group.id,
        name: group.name,
        status: group.status,
        synced: false,
        message: `Status ${group.status} tidak di-sync otomatis`,
      };
    }

    const slotCount = await this.ticketRepo.count({
      where: { group_id: groupId, status: In(SLOT_OCCUPYING_STATUSES) },
    });

    let newStatus = group.status;
    if (slotCount >= group.max_members) {
      newStatus = GroupStatus.FULL;
    } else {
      newStatus = GroupStatus.PENDING;
    }

    const changed = newStatus !== group.status;
    if (changed) {
      await this.groupRepo.update(groupId, { status: newStatus });
    }

    return {
      id: group.id,
      name: group.name,
      old_status: group.status,
      new_status: newStatus,
      slot_count: slotCount,
      max_slots: group.max_members,
      synced: changed,
      message: changed
        ? `Status diubah dari "${group.status}" → "${newStatus}"`
        : `Status sudah benar (${group.status})`,
    };
  }

  async getAllTickets(filters: { status?: TicketStatus; groupId?: string; userId?: string }): Promise<any[]> {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.groupId) where.group_id = filters.groupId;
    if (filters.userId) where.user_id = filters.userId;

    const tickets = await this.ticketRepo.find({
      where,
      relations: ['group', 'user'],
      order: { created_at: 'DESC' },
    });

    // Batch fetch latest payment per ticket
    const ticketIds = tickets.map((t) => t.id);
    const payments = ticketIds.length > 0
      ? await this.paymentRepo
          .createQueryBuilder('p')
          .where('p.ticket_id IN (:...ids)', { ids: ticketIds })
          .orderBy('p.created_at', 'DESC')
          .getMany()
      : [];

    const paymentMap = new Map<string, typeof payments[0]>();
    payments.forEach((p) => {
      if (!paymentMap.has(p.ticket_id)) paymentMap.set(p.ticket_id, p);
    });

    return tickets.map((t) => {
      const latestPayment = paymentMap.get(t.id) ?? null;
      return {
        id: t.id,
        ticket_code: t.ticket_code,
        status: t.status,
        created_at: t.created_at,
        group: {
          id: t.group.id,
          name: t.group.name,
          ticket_price: t.group.ticket_price,
          status: t.group.status,
        },
        user: {
          id: t.user.id,
          username: t.user.username,
          name: t.user.name,
        },
        latest_payment: latestPayment ? {
          id: latestPayment.id,
          status: latestPayment.status,
          proof_url: latestPayment.proof_url,
          amount: latestPayment.amount,
          note: latestPayment.note,
          created_at: latestPayment.created_at,
        } : null,
      };
    });
  }

  async getUserTickets(userId: string): Promise<any[]> {
    const tickets = await this.ticketRepo.find({
      where: { user_id: userId },
      relations: ['group', 'user'],
      order: { created_at: 'DESC' },
    });

    return tickets.map((t) => ({
      id: t.id,
      ticket_code: t.ticket_code,
      status: t.status,
      created_at: t.created_at,
      group: {
        id: t.group.id,
        name: t.group.name,
        ticket_price: t.group.ticket_price,
        status: t.group.status,
      },
      user: {
        id: t.user.id,
        username: t.user.username,
        name: t.user.name,
      },
    }));
  }
}
