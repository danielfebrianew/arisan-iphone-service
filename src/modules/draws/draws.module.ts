import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Draw } from './entities/draw.entity';
import { Group } from '../groups/entities/group.entity';
import { GroupMember } from '../groups/entities/group-member.entity';
import { Ticket } from '../tickets/entities/ticket.entity';
import { DrawsController } from './draws.controller';
import { DrawsService } from './draws.service';
import { AdminModule } from '../admin/admin.module';
import { IsKetuaGuard } from '../../common/guards/is-ketua.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Draw, Group, GroupMember, Ticket]), forwardRef(() => AdminModule)],
  controllers: [DrawsController],
  providers: [DrawsService, IsKetuaGuard],
  exports: [DrawsService],
})
export class DrawsModule {}
