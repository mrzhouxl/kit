/**
 * app.module.ts — 应用根模块
 */
import { Module } from "@nestjs/common";
import { ChatModule } from "./chat/chat.module.js";
import { ImageModule } from "./image/image.module.js";
import { SessionModule } from "./session/session.module.js";
import { AuthModule } from "./auth/auth.module.js";

@Module({
  imports: [AuthModule, ChatModule, ImageModule, SessionModule],
})
export class AppModule {}
