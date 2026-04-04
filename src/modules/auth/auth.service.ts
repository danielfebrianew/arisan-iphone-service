import {
  Injectable,
  ConflictException,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { nanoid } from 'nanoid';
import { User } from '../users/entities/user.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    private jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const existingUsername = await this.userRepo.findOne({
      where: { username: dto.username.toLowerCase() },
    });
    if (existingUsername) {
      throw new ConflictException('Username sudah digunakan');
    }

    const existingNik = await this.userRepo.findOne({
      where: { nik: dto.nik },
    });
    if (existingNik) {
      throw new ConflictException('NIK sudah terdaftar');
    }

    let referrerId: string | null = null;
    if (dto.referral_code) {
      const referrer = await this.userRepo.findOne({
        where: { referral_code: dto.referral_code },
      });
      if (!referrer || referrer.referral_code !== dto.referral_code) {
        throw new BadRequestException('Kode sponsor tidak valid');
      }
      referrerId = referrer.id;
    }

    const salt = await bcrypt.genSalt(12);
    const passwordHash = await bcrypt.hash(dto.password, salt);

    let referralCode: string;
    do {
      referralCode = nanoid(8);
    } while (
      await this.userRepo.findOne({ where: { referral_code: referralCode } })
    );

    const user = this.userRepo.create({
      username: dto.username.toLowerCase(),
      name: dto.name,
      password_hash: passwordHash,
      nik: dto.nik,
      phone: dto.phone,
      bank_name: dto.bank_name,
      bank_account_no: dto.bank_account_no,
      referral_code: referralCode,
      referred_by: referrerId,
    });
    const saved = await this.userRepo.save(user);

    return {
      id: saved.id,
      username: saved.username,
      referral_code: saved.referral_code,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.password_hash')
      .where('user.username = :username', {
        username: dto.username.toLowerCase(),
      })
      .getOne();

    if (!user) {
      throw new UnauthorizedException('Username atau password salah');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password_hash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Username atau password salah');
    }

    const payload = { sub: user.id, username: user.username, role: user.role };
    const access_token = this.jwtService.sign(payload);

    return {
      access_token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
      },
    };
  }

  async checkReferral(code: string) {
    if (!code) throw new BadRequestException('Kode tidak boleh kosong');

    const referrer = await this.userRepo.findOne({
      where: { referral_code: code },
      select: ['id', 'name', 'username', 'referral_code'],
    });

    if (!referrer || referrer.referral_code !== code) {
      throw new NotFoundException('Kode sponsor tidak valid');
    }

    return {
      valid: true,
      referrer_name: referrer.name,
      referrer_username: referrer.username,
    };
  }
}
