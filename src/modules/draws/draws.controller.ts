import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { Request } from 'express';
import { DrawsService } from './draws.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role } from '../users/entities/user.entity';
import { SpinDrawDto } from './dto/spin-draw.dto';

const forbidden403 = {
  statusCode: 403,
  message: 'Kamu tidak punya akses ke resource ini',
  error: 'Forbidden',
};

const unauthorized401 = {
  statusCode: 401,
  message: 'Unauthorized',
};

const groupExample = {
  id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  name: 'Grup Draw',
  icon: 'bike',
  prize: 'naik gunung',
  ticket_price: '10000000.00',
  next_draw_date: '2026-04-15',
};

const winnerExample = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  username: 'daniel_member',
  name: 'Daniel',
  role: 'member',
};

const winnerTicketExample = {
  id: 'b1c2d3e4-f5a6-7890-abcd-ef1234567890',
  ticket_code: 'TKT-E07402',
  slot_number: 1,
  status: 'won',
  created_at: '2026-04-03T22:28:23.678Z',
};

// Draw after pick-winner: still SCHEDULED, winner pre-selected
const pickWinnerResultExample = {
  id: 'd1e2f3a4-b5c6-7890-abcd-ef1234567890',
  group_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  status: 'scheduled',
  scheduled_date: '2026-04-15T00:00:00.000Z',
  winner_user_id: '550e8400-e29b-41d4-a716-446655440000',
  winner_ticket_id: 'b1c2d3e4-f5a6-7890-abcd-ef1234567890',
  drawn_at: null,
  created_at: '2026-03-15T10:00:00.000Z',
  updated_at: '2026-04-07T08:00:00.000Z',
  group: { ...groupExample, status: 'pending' },
  winner: winnerExample,
  winner_ticket: { ...winnerTicketExample, status: 'paid' },
};

// Draw after spin: COMPLETED
const drawResultExample = {
  id: 'd1e2f3a4-b5c6-7890-abcd-ef1234567890',
  group_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  status: 'completed',
  scheduled_date: '2026-04-15T00:00:00.000Z',
  winner_user_id: '550e8400-e29b-41d4-a716-446655440000',
  winner_ticket_id: 'b1c2d3e4-f5a6-7890-abcd-ef1234567890',
  drawn_at: '2026-04-15T14:00:00.000Z',
  created_at: '2026-03-15T10:00:00.000Z',
  updated_at: '2026-04-15T14:00:00.000Z',
  group: { ...groupExample, status: 'active' },
  winner: winnerExample,
  winner_ticket: winnerTicketExample,
};

// Draw after complete: group is completed
const completeResultExample = {
  ...drawResultExample,
  group: { ...groupExample, status: 'completed' },
};

const scheduledHistoryExample = {
  id: 'e2f3a4b5-c6d7-8901-abcd-ef1234567890',
  group_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  status: 'scheduled',
  scheduled_date: '2026-05-15T00:00:00.000Z',
  winner_user_id: null,
  winner_ticket_id: null,
  drawn_at: null,
  created_at: '2026-04-15T14:00:00.000Z',
  updated_at: '2026-04-15T14:00:00.000Z',
  group: { ...groupExample, status: 'active', next_draw_date: '2026-05-15' },
  winner: null,
  winner_ticket: null,
};

@ApiTags('Draws')
@ApiBearerAuth('JWT')
@Controller('draws')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class DrawsController {
  constructor(private readonly drawsService: DrawsService) {}

  @Post(':groupId/pick-winner')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Pick a winner for the draw (ADMIN only)',
    description: 'Admin selects a winner before the group becomes active. Can be called multiple times to change the winner while group is still pending or full. Winner is locked once group becomes active.',
  })
  @ApiParam({ name: 'groupId', type: String, description: 'Group ID (UUID)' })
  @ApiBody({
    type: SpinDrawDto,
    description: 'Selected winner for the draw',
    schema: {
      example: {
        winner_user_id: '550e8400-e29b-41d4-a716-446655440000',
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Winner picked successfully',
    schema: { example: pickWinnerResultExample },
  })
  @ApiResponse({
    status: 400,
    description: 'Group is not pending or full, or winner has no eligible ticket',
    schema: {
      examples: {
        group_not_eligible: {
          summary: 'Group is active or completed',
          value: { statusCode: 400, message: 'Winner can only be picked when group is pending or full', error: 'Bad Request' },
        },
        no_eligible_ticket: {
          summary: 'Winner has no paid/active ticket',
          value: { statusCode: 400, message: 'Selected winner does not have a paid or active ticket in this group', error: 'Bad Request' },
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated',
    schema: { example: unauthorized401 },
  })
  @ApiResponse({
    status: 403,
    description: 'Only admins can pick a winner',
    schema: { example: forbidden403 },
  })
  @ApiResponse({
    status: 404,
    description: 'Group or scheduled draw not found',
    schema: {
      examples: {
        group_not_found: {
          summary: 'Group not found',
          value: { statusCode: 404, message: 'Group <id> not found', error: 'Not Found' },
        },
        draw_not_found: {
          summary: 'No scheduled draw found',
          value: { statusCode: 404, message: 'No scheduled draw found for this group', error: 'Not Found' },
        },
      },
    },
  })
  pickWinner(
    @Param('groupId') groupId: string,
    @Body() dto: SpinDrawDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.drawsService.pickWinner(groupId, dto.winnerUserId, req.user.id);
  }

  @Post(':groupId/spin')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Spin the draw wheel to reveal the winner (ADMIN only)',
    description: 'Reveals the pre-selected winner. Group must be active and a winner must have been picked via pick-winner first. Marks tickets as WON/EXPIRED and completes the draw.',
  })
  @ApiParam({ name: 'groupId', type: String, description: 'Group ID (UUID)' })
  @ApiResponse({
    status: 201,
    description: 'Spin completed, winner revealed',
    schema: { example: drawResultExample },
  })
  @ApiResponse({
    status: 400,
    description: 'Group not active, winner not picked yet, or draw date not reached',
    schema: {
      examples: {
        group_not_active: {
          summary: 'Group is not active',
          value: { statusCode: 400, message: 'Group must be active to perform spin', error: 'Bad Request' },
        },
        winner_not_picked: {
          summary: 'Winner not picked yet',
          value: { statusCode: 400, message: 'Winner has not been picked yet. Run pick-winner first.', error: 'Bad Request' },
        },
        draw_date_not_reached: {
          summary: 'Draw date not reached',
          value: { statusCode: 400, message: 'Draw is not yet available. Scheduled for 2026-04-15', error: 'Bad Request' },
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated',
    schema: { example: unauthorized401 },
  })
  @ApiResponse({
    status: 403,
    description: 'Only admins can perform the spin',
    schema: { example: forbidden403 },
  })
  @ApiResponse({
    status: 404,
    description: 'Group or scheduled draw not found',
    schema: {
      examples: {
        group_not_found: {
          summary: 'Group not found',
          value: { statusCode: 404, message: 'Group <id> not found', error: 'Not Found' },
        },
        draw_not_found: {
          summary: 'No scheduled draw found',
          value: { statusCode: 404, message: 'No scheduled draw found for this group', error: 'Not Found' },
        },
      },
    },
  })
  spin(
    @Param('groupId') groupId: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.drawsService.spin(groupId, req.user.id);
  }

  @Post(':groupId/complete')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Complete a group after spin (ADMIN only)',
    description: 'Marks the group as completed. Can only be called after spin has been performed and a winner has been selected.',
  })
  @ApiParam({ name: 'groupId', type: String, description: 'Group ID (UUID)' })
  @ApiResponse({
    status: 201,
    description: 'Group completed successfully',
    schema: { example: completeResultExample },
  })
  @ApiResponse({
    status: 400,
    description: 'Group is not active or spin has not been performed yet',
    schema: {
      examples: {
        group_not_active: {
          summary: 'Group is not active',
          value: { statusCode: 400, message: 'Group is not active', error: 'Bad Request' },
        },
        spin_not_done: {
          summary: 'Spin not performed yet',
          value: { statusCode: 400, message: 'No completed draw with a winner found. Run spin first.', error: 'Bad Request' },
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated',
    schema: { example: unauthorized401 },
  })
  @ApiResponse({
    status: 403,
    description: 'Only admins can complete a group',
    schema: { example: forbidden403 },
  })
  @ApiResponse({
    status: 404,
    description: 'Group not found',
    schema: {
      example: { statusCode: 404, message: 'Group <id> not found', error: 'Not Found' },
    },
  })
  complete(
    @Param('groupId') groupId: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.drawsService.complete(groupId, req.user.id);
  }

  @Get(':groupId/result')
  @ApiOperation({ summary: 'Get latest draw result for a group' })
  @ApiParam({ name: 'groupId', type: String, description: 'Group ID (UUID)' })
  @ApiResponse({
    status: 200,
    description: 'Draw result retrieved',
    schema: { example: drawResultExample },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated',
    schema: { example: unauthorized401 },
  })
  @ApiResponse({
    status: 404,
    description: 'No completed draw found for this group',
    schema: {
      example: { statusCode: 404, message: 'No completed draw found for this group', error: 'Not Found' },
    },
  })
  getResult(@Param('groupId') groupId: string) {
    return this.drawsService.getDrawResult(groupId);
  }

  @Get(':groupId/history')
  @ApiOperation({ summary: 'Get all draw records for a group' })
  @ApiParam({ name: 'groupId', type: String, description: 'Group ID (UUID)' })
  @ApiResponse({
    status: 200,
    description: 'Draw history retrieved',
    schema: { example: [drawResultExample, scheduledHistoryExample] },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated',
    schema: { example: unauthorized401 },
  })
  getHistory(@Param('groupId') groupId: string) {
    return this.drawsService.getHistory(groupId);
  }
}
