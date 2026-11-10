-- Graph error 190 means the stored token can no longer call the API.
-- The account stays connected so campaigns are not deleted, and Settings
-- asks the owner to reconnect.

-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN "needsReconnect" BOOLEAN NOT NULL DEFAULT false;
