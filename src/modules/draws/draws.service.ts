import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { Draw, DrawStatus } from './entities/draw.entity';
import { Group, GroupStatus } from '../groups/entities/group.entity';
import { Ticket, TicketStatus } from '../tickets/entities/ticket.entity';
import { ActivityLogService } from '../admin/services/activity-log.service';
import { ActivityAction, ActivityTargetType } from '../admin/entities/activity-log.entity';
import { User } from '../users/entities/user.entity';

const DRAW_ELIGIBLE_TICKET_STATUSES = [TicketStatus.PAID, TicketStatus.ACTIVE];

@Injectable()
export class DrawsService {
  constructor(
    @InjectRepository(Draw)
    private readonly drawRepo: Repository<Draw>,
    @InjectRepository(Group)
    private readonly groupRepo: Repository<Group>,
    @InjectRepository(Ticket)
    private readonly ticketRepo: Repository<Ticket>,
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => ActivityLogService))
    private readonly activityLogService: ActivityLogService,
  ) {}

  async createScheduledDraw(groupId: string, scheduledDate: Date): Promise<Draw> {
    const draw = this.drawRepo.create({
      group_id: groupId,
      status: DrawStatus.SCHEDULED,
      scheduled_date: new Date(scheduledDate),
    });
    return this.drawRepo.save(draw);
  }

  async syncScheduledDrawDate(groupId: string, scheduledDate: Date): Promise<void> {
    await this.drawRepo.update(
      { group_id: groupId, status: DrawStatus.SCHEDULED },
      { scheduled_date: new Date(scheduledDate) },
    );
  }

  private async enrichDraw(draw: Draw): Promise<any> {
    const [group, winner, winnerTicket] = await Promise.all([
      this.groupRepo.findOne({ where: { id: draw.group_id } }),
      draw.winner_user_id
        ? this.dataSource.manager.findOne(User, { where: { id: draw.winner_user_id } })
        : Promise.resolve(null),
      draw.winner_ticket_id
        ? this.ticketRepo.findOne({ where: { id: draw.winner_ticket_id } })
        : Promise.resolve(null),
    ]);

    return {
      ...draw,
      group: group
        ? {
            id: group.id,
            name: group.name,
            status: group.status,
            icon: group.icon,
            prize: group.prize,
            ticket_price: group.ticket_price,
            next_draw_date: group.next_draw_date,
          }
        : null,
      winner: winner
        ? {
            id: winner.id,
            username: winner.username,
            name: winner.name,
            role: winner.role,
          }
        : null,
      winner_ticket: winnerTicket
        ? {
            id: winnerTicket.id,
            ticket_code: winnerTicket.ticket_code,
            slot_number: winnerTicket.slot_number,
            status: winnerTicket.status,
            created_at: winnerTicket.created_at,
          }
        : null,
    };
  }

  async spin(groupId: string, winnerUserId: string, adminUserId: string): Promise<any> {
    // 1. Validate group exists and is ACTIVE
    const group = await this.groupRepo.findOne({ where: { id: groupId } });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);
    if (group.status !== GroupStatus.ACTIVE) {
      throw new BadRequestException('Group is not active');
    }

    // 2. Validate draw exists and scheduled_date has passed
    const draw = await this.drawRepo.findOne({
      where: { group_id: groupId, status: DrawStatus.SCHEDULED },
    });
    if (!draw) {
      throw new NotFoundException('No scheduled draw found for this group');
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const scheduledDate = new Date(draw.scheduled_date);
    scheduledDate.setHours(0, 0, 0, 0);

    if (today < scheduledDate) {
      throw new BadRequestException(
        `Draw is not yet available. Scheduled for ${scheduledDate.toISOString().split('T')[0]}`,
      );
    }

    // 3. Validate selected winner has a paid or active ticket in this group
    const winnerTicket = await this.ticketRepo.findOne({
      where: {
        group_id: groupId,
        user_id: winnerUserId,
        status: In(DRAW_ELIGIBLE_TICKET_STATUSES),
      },
      order: { created_at: 'ASC' },
    });

    if (!winnerTicket) {
      throw new BadRequestException('Selected winner does not have a paid or active ticket in this group');
    }

    // 4. Post-spin transaction
    await this.dataSource.transaction(async (manager) => {
      // Winning ticket → WON
      await manager.update(Ticket, winnerTicket.id, { status: TicketStatus.WON });

      // All other tickets of winner → WON
      await manager
        .createQueryBuilder()
        .update(Ticket)
        .set({ status: TicketStatus.WON })
        .where('group_id = :groupId', { groupId })
        .andWhere('user_id = :userId', { userId: winnerUserId })
        .andWhere('id != :winnerTicketId', { winnerTicketId: winnerTicket.id })
        .andWhere('status IN (:...statuses)', {
          statuses: DRAW_ELIGIBLE_TICKET_STATUSES,
        })
        .execute();

      // All paid or active tickets of other users → EXPIRED
      await manager
        .createQueryBuilder()
        .update(Ticket)
        .set({ status: TicketStatus.EXPIRED })
        .where('group_id = :groupId', { groupId })
        .andWhere('user_id != :userId', { userId: winnerUserId })
        .andWhere('status IN (:...statuses)', {
          statuses: DRAW_ELIGIBLE_TICKET_STATUSES,
        })
        .execute();

      // Draw → COMPLETED
      await manager.update(Draw, draw.id, {
        status: DrawStatus.COMPLETED,
        winner_user_id: winnerUserId,
        winner_ticket_id: winnerTicket.id,
        drawn_at: new Date(),
      });

      // Group → COMPLETED
      await manager.update(Group, groupId, { status: GroupStatus.COMPLETED });
    });

    // Log activity after transaction
    const groupData = await this.groupRepo.findOne({ where: { id: groupId } });
    const winnerData = await this.dataSource.manager.findOne(User, { where: { id: winnerUserId } });

    if (groupData && winnerData) {
      await this.activityLogService.log({
        actorId: adminUserId,
        action: ActivityAction.DRAW_EXECUTED,
        targetType: ActivityTargetType.GROUP,
        targetId: groupId,
        metadata: {
          group_name: groupData.name,
          winner_name: winnerData.name,
        },
      });
    }

    const completedDraw = await this.drawRepo.findOne({ where: { id: draw.id } });
    if (!completedDraw) {
      throw new NotFoundException(`Draw ${draw.id} not found after completion`);
    }

    return this.enrichDraw(completedDraw);
  }

  async getDrawResult(groupId: string): Promise<any> {
    const draw = await this.drawRepo.findOne({
      where: { group_id: groupId, status: DrawStatus.COMPLETED },
    });
    if (!draw) {
      throw new NotFoundException('No completed draw found for this group');
    }
    return this.enrichDraw(draw);
  }

  async getHistory(groupId: string): Promise<any[]> {
    const draws = await this.drawRepo.find({
      where: { group_id: groupId },
      order: { created_at: 'DESC' },
    });

    return Promise.all(draws.map((draw) => this.enrichDraw(draw)));
  }
}
