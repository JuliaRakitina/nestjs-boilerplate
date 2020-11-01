import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from '../users/user.entity';
import { In, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import {
  AuthEmailLoginDto,
  AuthRegisterLoginDto,
  AuthSocialLoginDto,
  AuthUpdateDto,
} from './auth.dto';
import { MailerService } from '@nestjs-modules/mailer';
import { randomStringGenerator } from '@nestjs/common/utils/random-string-generator.util';
import { Forgot } from '../forgot/forgot.entity';
import { RoleEnum } from 'src/roles/roles.enum';
import { StatusEnum } from 'src/statuses/statuses.enum';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { plainToClass } from 'class-transformer';
import { Status } from 'src/statuses/status.entity';
import { Role } from 'src/roles/role.entity';
import { AuthProvidersEnum } from './auth-providers.enum';
import { AppleService } from 'src/apple/apple.service';
import { FacebookService } from 'src/facebook/facebook.service';
import { GoogleService } from 'src/google/google.service';
import { SocialInterface } from 'src/social/social.interface';
import { TwitterService } from 'src/twitter/twitter.service';

@Injectable()
export class AuthService {
  constructor(
    private mailerService: MailerService,
    private configService: ConfigService,
    private jwtService: JwtService,
    private facebookService: FacebookService,
    private googleService: GoogleService,
    private twitterService: TwitterService,
    private appleService: AppleService,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(Forgot)
    private forgotRepository: Repository<Forgot>,
  ) {}

  async validateLogin(
    loginDto: AuthEmailLoginDto,
    onlyAdmin: boolean,
  ): Promise<{ token: string; user: User }> {
    const user = await this.usersRepository.findOne({
      where: {
        email: loginDto.email.toLowerCase(),
        role: onlyAdmin ? In([RoleEnum.admin]) : In([RoleEnum.user]),
      },
    });

    if (!user) {
      throw new HttpException(
        {
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          errors: {
            email: 'notFound',
          },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const isValidPassword = await bcrypt.compare(
      loginDto.password,
      user.password,
    );

    if (isValidPassword) {
      const token = await this.jwtService.sign({
        id: user.id,
        role: user.role,
      });

      return { token, user: user };
    } else {
      throw new HttpException(
        {
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          errors: {
            password: 'incorrectPassword',
          },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  async validateSocialLogin(
    dto: AuthSocialLoginDto,
  ): Promise<{ token: string; user: User }> {
    let socialData: SocialInterface;
    let user: User;

    switch (dto.socialType) {
      case AuthProvidersEnum.facebook:
        socialData = await this.facebookService.getProfileByToken(dto.tokens);
        break;
      case AuthProvidersEnum.google:
        socialData = await this.googleService.getProfileByToken(dto.tokens);
        break;
      case AuthProvidersEnum.twitter:
        socialData = await this.twitterService.getProfileByToken(dto.tokens);
        break;
      case AuthProvidersEnum.apple:
        socialData = await this.appleService.getProfileByToken(dto.tokens);
        break;
      default:
        throw new HttpException(
          {
            status: HttpStatus.UNPROCESSABLE_ENTITY,
            errors: {
              socialType: 'notFountSocialType',
            },
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
    }

    const userByEmail = await this.usersRepository.findOne({
      email: socialData.email?.toLowerCase(),
    });

    user = await this.usersRepository.findOne({
      socialId: socialData.id,
      provider: dto.socialType,
    });

    if (user) {
      if (socialData.email && !userByEmail) {
        user.email = socialData.email?.toLowerCase();
      }
      await this.usersRepository.save(user);
    } else if (userByEmail) {
      user = userByEmail;

      if (socialData.email && !userByEmail) {
        user.email = socialData.email?.toLowerCase();
      }

      await this.usersRepository.save(user);
    } else {
      const role = plainToClass(Role, {
        id: RoleEnum.user,
      });
      const status = plainToClass(Status, {
        id: StatusEnum.active,
      });

      const userFirstName = socialData.firstName ?? dto.firstName;
      const userLastName = socialData.lastName ?? dto.lastName;

      user = await this.usersRepository.save(
        plainToClass(User, {
          email: socialData.email?.toLowerCase(),
          firstName: userFirstName,
          lastName: userLastName,
          socialId: socialData.id,
          provider: dto.socialType,
          role,
          status,
        }),
      );

      user = await this.usersRepository.findOne(user.id);
    }

    const jwtToken = await this.jwtService.sign({
      id: user.id,
      role: user.role,
    });

    return {
      token: jwtToken,
      user,
    };
  }

  async register(dto: AuthRegisterLoginDto): Promise<void> {
    const hash = crypto
      .createHash('sha256')
      .update(randomStringGenerator())
      .digest('hex');

    const user = await this.usersRepository.save(
      plainToClass(User, {
        ...dto,
        email: dto.email?.toLowerCase(),
        role: {
          id: RoleEnum.user,
        },
        status: {
          id: StatusEnum.inactive,
        },
        hash,
      }),
    );

    await this.mailerService.sendMail({
      to: user.email,
      subject: 'Confirm email',
      text: `${this.configService.get(
        'app.domain',
      )}/confirm-email/${hash} Confirm email`,
      template: 'activation',
      context: {
        url: `${this.configService.get('app.domain')}/confirm-email/${hash}`,
      },
    });
  }

  async confirmEmail(hash: string): Promise<void> {
    const user = await this.usersRepository.findOne({
      hash,
    });

    if (!user) {
      throw new HttpException(
        {
          status: HttpStatus.NOT_FOUND,
          error: `notFound`,
        },
        HttpStatus.NOT_FOUND,
      );
    }

    user.hash = null;
    user.status = plainToClass(Status, {
      id: StatusEnum.active,
    });
    user.save();
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.usersRepository.findOne({
      email: email?.toLowerCase(),
    });

    if (!user) {
      throw new HttpException(
        {
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          errors: {
            email: 'notFound',
          },
        },
        HttpStatus.NOT_FOUND,
      );
    } else {
      const hash = crypto
        .createHash('sha256')
        .update(randomStringGenerator())
        .digest('hex');
      await this.forgotRepository.save(
        plainToClass(Forgot, {
          hash,
          user,
        }),
      );
      await this.mailerService.sendMail({
        to: email,
        subject: 'Reset password',
        text: `${this.configService.get(
          'app.domain',
        )}/password-change/${hash} Reset password`,
        template: 'reset-password',
        context: {
          url: `${this.configService.get(
            'app.domain',
          )}/password-change/${hash}`,
        },
      });
    }
  }

  async resetPassword(hash: string, password: string): Promise<void> {
    const forgot = await this.forgotRepository.findOne({
      hash,
    });

    if (!forgot) {
      throw new HttpException(
        {
          status: HttpStatus.NOT_FOUND,
          error: `notFound`,
        },
        HttpStatus.NOT_FOUND,
      );
    }

    const user = forgot.user;
    user.password = password;
    user.save();
    await this.forgotRepository.softDelete(forgot.id);
  }

  async me(user: User): Promise<User> {
    return this.usersRepository.findOne({
      id: user.id,
    });
  }

  async update(user: User, userDto: AuthUpdateDto): Promise<User> {
    await this.usersRepository.save(
      plainToClass(User, {
        id: user.id,
        ...userDto,
      }),
    );

    return this.usersRepository.findOne(user.id);
  }

  async softDelete(user: User): Promise<void> {
    await this.usersRepository.softDelete(user.id);
  }
}