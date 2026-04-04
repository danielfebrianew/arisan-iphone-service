import { IsString, IsNotEmpty, IsNumber, IsOptional, IsIn } from 'class-validator';

export const GROUP_ICONS = ['smartphone', 'bike', 'shopping-bag'] as const;
export type GroupIcon = typeof GROUP_ICONS[number];

export class CreateGroupDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsNumber()
  @IsOptional()
  max_members?: number;

  @IsNumber()
  @IsOptional()
  ticket_price?: number;

  @IsString()
  @IsOptional()
  prize?: string;

  @IsIn(GROUP_ICONS)
  @IsOptional()
  icon?: GroupIcon;
}
