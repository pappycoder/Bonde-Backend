import { Controller, All, NotFoundException, Logger } from '@nestjs/common';

/**
 * Catch-all for unmatched routes.
 *
 * Nest routes known paths to their handlers, but unknown paths fall through to
 * Express's default HTML 404. This controller re-raises a `NotFoundException`
 * so every unknown path is normalized through the global exception filter and
 * returned as the uniform JSON error shape.
 *
 * IMPORTANT: This module is imported LAST in AppModule, so all feature routes
 * register before this wildcard and take precedence.
 */
@Controller()
export class CatchAllController {
  private readonly logger = new Logger('CatchAllController');

  @All('*splat')
  handleUnmatched(): never {
    this.logger.warn('Unmatched route requested');
    throw new NotFoundException('Route not found');
  }
}
