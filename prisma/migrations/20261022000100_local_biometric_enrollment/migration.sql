-- Local OS biometric enrollment is metadata, not a server signing credential.
ALTER TYPE "BiometricType" ADD VALUE IF NOT EXISTS 'DEVICE';
ALTER TABLE "biometric_devices" ALTER COLUMN "public_key" DROP NOT NULL;
