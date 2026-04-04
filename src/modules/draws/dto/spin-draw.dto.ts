import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class SpinDrawDto {
  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'User ID of the selected winner',
  })
  @IsUUID()
  @IsNotEmpty()
  winner_user_id!: string;

  get winnerUserId(): string {
    return this.winner_user_id;
  }
}
