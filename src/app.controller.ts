import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AppService } from './app.service.js';
import { Public } from './modules/auth/decorators/public.decorator.js';

@ApiExcludeController()
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Public()
  @Header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  getHello(): string {
    return this.appService.getHello();
  }
}
