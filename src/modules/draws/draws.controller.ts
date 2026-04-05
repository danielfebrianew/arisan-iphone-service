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

const drawExample = {
  id: 'd1e2f3a4-b5c6-7890-abcd-ef1234567890',
  group_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  status: 'completed',
  scheduled_date: '2026-04-15T00:00:00.000Z',
  winner_user_id: '550e8400-e29b-41d4-a716-446655440000',
  winner_ticket_id: 'b1c2d3e4-f5a6-7890-abcd-ef1234567890',
  drawn_at: '2026-04-15T14:00:00.000Z',
  created_at: '2026-03-15T10:00:00.000Z',
  updated_at: '2026-04-15T14:00:00.000Z',
};

const drawResultExample = {
  ...drawExample,
  group: {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'Grup Draw',
    status: 'completed',
    icon: 'bike',
    prize: 'naik gunung',
    ticket_price: '10000000.00',
    next_draw_date: '2026-04-10',
  },
  winner: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    username: 'daniel_member',
    name: 'Daniel',
    role: 'member',
  },
  winner_ticket: {
    id: 'b1c2d3e4-f5a6-7890-abcd-ef1234567890',
    ticket_code: 'TKT-E07402',
    slot_number: 1,
    status: 'won',
    created_at: '2026-04-03T22:28:23.678Z',
  },
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
  group: {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'Grup Draw',
    status: 'active',
    icon: 'bike',
    prize: 'naik gunung',
    ticket_price: '10000000.00',
    next_draw_date: '2026-05-15',
  },
  winner: null,
  winner_ticket: null,
};

@ApiTags('Draws')
@ApiBearerAuth('JWT')
@Controller('draws')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class DrawsController {
  constructor(private readonly drawsService: DrawsService) {}

  @Post(':groupId/spin')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Trigger draw/spin by selecting a winner (ADMIN only)',
    description: 'Only admins can complete a scheduled draw by selecting a winner with an active ticket in the target group.',
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
    description: 'Draw spin completed successfully',
    schema: {
      example: drawResultExample,
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Group not active, winner has no paid or active ticket, or draw date not reached',
    schema: {
      example: {
        statusCode: 400,
        message: 'Draw is not yet available. Scheduled for 2026-04-15',
        error: 'Bad Request',
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'Only admins can perform the spin',
    schema: {
      example: {
        statusCode: 403,
        message: 'Kamu tidak punya akses ke resource ini',
        error: 'Forbidden',
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Group or scheduled draw not found' })
  spin(
    @Param('groupId') groupId: string,
    @Body() dto: SpinDrawDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.drawsService.spin(groupId, dto.winnerUserId, req.user.id);
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
    schema: { example: drawResultExample },
  })
  @ApiResponse({
    status: 400,
    description: 'Group is not active or spin has not been performed yet',
    schema: {
      example: {
        statusCode: 400,
        message: 'No completed draw with a winner found. Run spin first.',
        error: 'Bad Request',
      },
    },
  })
  @ApiResponse({ status: 403, description: 'Only admins can complete a group' })
  @ApiResponse({ status: 404, description: 'Group not found' })
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
    schema: {
      example: drawResultExample,
    },
  })
  @ApiResponse({
    status: 404,
    description: 'No completed draw found',
    schema: {
      example: {
        statusCode: 404,
        message: 'No completed draw found for this group',
        error: 'Not Found',
      },
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
    schema: {
      example: [
        drawResultExample,
        scheduledHistoryExample,
      ],
    },
  })
  getHistory(@Param('groupId') groupId: string) {
    return this.drawsService.getHistory(groupId);
  }
}
