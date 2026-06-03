/**
 * session/session.module.ts — 会话功能模块
 */
import { Module } from "@nestjs/common";
import { SessionController } from "./session.controller.js";

@Module({
  controllers: [SessionController],
})
export class SessionModule {}
