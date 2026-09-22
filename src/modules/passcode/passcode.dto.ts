import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

const PASSCODE_REGEX = /^[0-9]{4}$/;
const PASSCODE_MESSAGE = 'must be exactly 4 digits';

/** Body for `POST /api/passcode`. */
export class CreatePasscodeDto {
  @ApiProperty({ example: '1234', description: '4-digit passcode' })
  @Matches(PASSCODE_REGEX, { message: `passcode ${PASSCODE_MESSAGE}` })
  passcode: string;
}

/** Body for `PATCH /api/passcode`. */
export class UpdatePasscodeDto {
  @ApiProperty({ example: '1234', description: 'Current 4-digit passcode' })
  @Matches(PASSCODE_REGEX, { message: `currentPasscode ${PASSCODE_MESSAGE}` })
  currentPasscode: string;

  @ApiProperty({ example: '5678', description: 'New 4-digit passcode' })
  @Matches(PASSCODE_REGEX, { message: `newPasscode ${PASSCODE_MESSAGE}` })
  newPasscode: string;
}

/** Body for `POST /api/passcode/validate`. */
export class ValidatePasscodeDto {
  @ApiProperty({ example: '1234', description: '4-digit passcode to validate' })
  @Matches(PASSCODE_REGEX, { message: `passcode ${PASSCODE_MESSAGE}` })
  passcode: string;
}

/** Response for `GET /api/passcode`. */
export class PasscodeStatusDto {
  @ApiProperty({ example: false, description: 'Whether a passcode is set' })
  hasPasscode: boolean;
}

/** Response for a successful `POST /api/passcode/validate`. */
export class PasscodeValidDto {
  @ApiProperty({ example: true })
  valid: true;
}
