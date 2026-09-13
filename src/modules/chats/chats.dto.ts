import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MessageRole } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/** Query parameters for `GET /api/chats`. */
export class ListChatsQueryDto {
  @ApiPropertyOptional({
    example: 'travel',
    description: 'Free-text search across the chat title',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    example: 'title:Travel',
    description: 'No filterable fields on chats — passing any `filter=` returns 400',
  })
  @IsOptional()
  filter?: string | string[];

  @ApiPropertyOptional({ example: 1, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ example: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  pageSize?: number;
}

/** Body for `POST /api/chats`. */
export class CreateChatDto {
  @ApiPropertyOptional({ example: 'Onboarding chat' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title?: string;
}

/** Body for `PATCH /api/chats/:id`. */
export class UpdateChatDto {
  @ApiPropertyOptional({ example: 'Travel planning' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title?: string;
}

/** A chat session returned to the owning user. */
export class ChatDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  userId: string;

  @ApiProperty({ type: String, nullable: true, example: 'Onboarding chat' })
  title: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

/** Paged envelope for `GET /api/chats`. */
export class PagedChatsDto {
  @ApiProperty({ type: [ChatDto] })
  items: ChatDto[];

  @ApiProperty({ example: 1 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  pageSize: number;

  @ApiProperty({ example: 1 })
  totalPages: number;
}

/** Query parameters for `GET /api/chats/:id/messages`. */
export class ListMessagesQueryDto {
  @ApiPropertyOptional({
    example: 'send 2000',
    description: 'Free-text search across the message content',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({
    example: 'role:USER',
    description:
      'Repeatable `field:value` (equality on enums/numbers) or `field:op:value` filters (`role`)',
  })
  @IsOptional()
  filter?: string | string[];

  @ApiPropertyOptional({ example: 1, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ example: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  pageSize?: number;
}

/** Body for `POST /api/chats/:id/messages`. */
export class CreateMessageDto {
  @ApiProperty({ example: 'Send 2000 to my wallet' })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content: string;
}

/** A message inside a chat. */
export class MessageDto {
  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  chatId: string;

  @ApiProperty({ enum: MessageRole, example: MessageRole.USER })
  role: MessageRole;

  @ApiProperty({ example: 'Send 2000 to my wallet' })
  content: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** Paged envelope for `GET /api/chats/:id/messages`. */
export class PagedMessagesDto {
  @ApiProperty({ type: [MessageDto] })
  items: MessageDto[];

  @ApiProperty({ example: 1 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  pageSize: number;

  @ApiProperty({ example: 1 })
  totalPages: number;
}

/** Response for `DELETE /api/chats/:id`. */
export class ChatsDeleteResponseDto {
  @ApiProperty({ example: true })
  deleted: true;

  @ApiProperty({ format: 'uuid', example: '673bc257-9204-4acb-acf5-61f51e20a328' })
  id: string;
}
