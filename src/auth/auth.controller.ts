import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from './current-user.decorator.js';
import type { AuthPrincipal } from './auth-principal.js';

@Controller('auth')
export class AuthController {
  @Get('me')
  me(@CurrentUser() user: AuthPrincipal): AuthPrincipal {
    return user;
  }
}
