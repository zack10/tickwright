
-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_senderId_fkey";

-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_receiverId_fkey";

-- DropTable
DROP TABLE "Message";

