import { IsBoolean } from 'class-validator';

export class SetKetuaDto {
  @IsBoolean()
  is_ketua!: boolean;
}
