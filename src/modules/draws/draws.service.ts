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

  async pickWinner(groupId: string, winnerUserId: string, adminUserId: string): Promise<any> {
    // 1. Validate group exists and is PENDING or FULL
    const group = await this.groupRepo.findOne({ where: { id: groupId } });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);
    if (![GroupStatus.PENDING, GroupStatus.FULL].includes(group.status)) {
      throw new BadRequestException('Winner can only be picked when group is pending or full');
    }

    // 2. Validate scheduled draw exists
    const draw = await this.drawRepo.findOne({
      where: { group_id: groupId, status: DrawStatus.SCHEDULED },
    });
    if (!draw) throw new NotFoundException('No scheduled draw found for this group');

    // 3. Validate winner has an eligible ticket
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

    // 4. Set (or overwrite) winner on the draw — no ticket status changes yet
    await this.drawRepo.update(draw.id, {
      winner_user_id: winnerUserId,
      winner_ticket_id: winnerTicket.id,
    });

    // 5. Log activity
    const [groupData, winnerData] = await Promise.all([
      this.groupRepo.findOne({ where: { id: groupId } }),
      this.dataSource.manager.findOne(User, { where: { id: winnerUserId } }),
    ]);
    if (groupData && winnerData) {
      await this.activityLogService.log({
        actorId: adminUserId,
        action: ActivityAction.DRAW_EXECUTED,
        targetType: ActivityTargetType.GROUP,
        targetId: groupId,
        metadata: { group_name: groupData.name, winner_name: winnerData.name },
      });
    }

    const updatedDraw = await this.drawRepo.findOne({ where: { id: draw.id } });
    if (!updatedDraw) throw new NotFoundException(`Draw ${draw.id} not found`);
    return this.enrichDraw(updatedDraw);
  }

  async spin(groupId: string, adminUserId: string): Promise<any> {
    // 1. Validate group is ACTIVE
    const group = await this.groupRepo.findOne({ where: { id: groupId } });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);
    if (group.status !== GroupStatus.ACTIVE) {
      throw new BadRequestException('Group must be active to perform spin');
    }

    // 2. Validate draw is SCHEDULED and winner already picked
    const draw = await this.drawRepo.findOne({
      where: { group_id: groupId, status: DrawStatus.SCHEDULED },
    });
    if (!draw) throw new NotFoundException('No scheduled draw found for this group');
    if (!draw.winner_user_id || !draw.winner_ticket_id) {
      throw new BadRequestException('Winner has not been picked yet. Run pick-winner first.');
    }

    // 3. Validate scheduled_date has passed
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const scheduledDate = new Date(draw.scheduled_date);
    scheduledDate.setHours(0, 0, 0, 0);
    if (today < scheduledDate) {
      throw new BadRequestException(
        `Draw is not yet available. Scheduled for ${scheduledDate.toISOString().split('T')[0]}`,
      );
    }

    // 4. Execute spin transaction — reveal winner
    await this.dataSource.transaction(async (manager) => {
      // Winning ticket → WON
      await manager.update(Ticket, draw.winner_ticket_id, { status: TicketStatus.WON });

      // All other winner's eligible tickets → WON
      await manager
        .createQueryBuilder()
        .update(Ticket)
        .set({ status: TicketStatus.WON })
        .where('group_id = :groupId', { groupId })
        .andWhere('user_id = :userId', { userId: draw.winner_user_id })
        .andWhere('id != :winnerTicketId', { winnerTicketId: draw.winner_ticket_id })
        .andWhere('status IN (:...statuses)', { statuses: DRAW_ELIGIBLE_TICKET_STATUSES })
        .execute();

      // All other users' eligible tickets → EXPIRED
      await manager
        .createQueryBuilder()
        .update(Ticket)
        .set({ status: TicketStatus.EXPIRED })
        .where('group_id = :groupId', { groupId })
        .andWhere('user_id != :userId', { userId: draw.winner_user_id })
        .andWhere('status IN (:...statuses)', { statuses: DRAW_ELIGIBLE_TICKET_STATUSES })
        .execute();

      // Draw → COMPLETED
      await manager.update(Draw, draw.id, {
        status: DrawStatus.COMPLETED,
        drawn_at: new Date(),
      });
    });

    const completedDraw = await this.drawRepo.findOne({ where: { id: draw.id } });
    if (!completedDraw) throw new NotFoundException(`Draw ${draw.id} not found after spin`);
    return this.enrichDraw(completedDraw);
  }

  async complete(groupId: string, adminUserId: string): Promise<any> {
    // 1. Validate group exists and is ACTIVE
    const group = await this.groupRepo.findOne({ where: { id: groupId } });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);
    if (group.status !== GroupStatus.ACTIVE) {
      throw new BadRequestException('Group is not active');
    }

    // 2. Validate a completed draw with a winner exists
    const draw = await this.drawRepo.findOne({
      where: { group_id: groupId, status: DrawStatus.COMPLETED },
    });
    if (!draw || !draw.winner_user_id) {
      throw new BadRequestException('No completed draw with a winner found. Run spin first.');
    }

    // 3. Mark group as completed
    await this.groupRepo.update(groupId, { status: GroupStatus.COMPLETED });

    // 4. Log activity
    const groupData = await this.groupRepo.findOne({ where: { id: groupId } });
    if (groupData) {
      await this.activityLogService.log({
        actorId: adminUserId,
        action: ActivityAction.GROUP_COMPLETED,
        targetType: ActivityTargetType.GROUP,
        targetId: groupId,
        metadata: { group_name: groupData.name },
      });
    }

    return this.enrichDraw(draw);
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
