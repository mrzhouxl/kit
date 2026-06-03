/**
 * session/session.controller.ts — 聊天会话 REST API
 *
 * 提供会话 CRUD 和消息查询接口：
 *   POST   /api/sessions              → 创建新会话
 *   GET    /api/sessions              → 获取用户会话列表
 *   GET    /api/sessions/:id          → 获取单个会话详情
 *   GET    /api/sessions/:id/messages → 获取会话消息列表
 *   PATCH  /api/sessions/:id          → 更新会话标题
 *   DELETE /api/sessions/:id          → 删除会话
 */
import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Request } from "express";
import * as sessionService from "./session.service.js";
import { extractUserIdFromAuthorizationHeader } from "../auth/jwt.js";

@Controller("api/sessions")
export class SessionController {
  /**
   * 从请求头 Authorization 中解析用户 ID，并校验 JWT 签名。
   */
  private extractUserId(req: Request): number {
    return extractUserIdFromAuthorizationHeader(req.headers.authorization);
  }

  // ---------- 创建会话 ----------

  @Post()
  async create(
    @Body() body: { title?: string; mode?: string },
    @Req() req: Request,
  ) {
    const userId = this.extractUserId(req);
    const session = await sessionService.createSession({
      userId,
      title: body.title,
      mode: body.mode,
    });
    return { session };
  }

  // ---------- 会话列表 ----------

  @Get()
  async list(@Req() req: Request) {
    const userId = this.extractUserId(req);
    const sessions = await sessionService.listSessions(userId);
    return { sessions };
  }

  // ---------- 会话详情 ----------

  @Get(":id")
  async detail(@Param("id") id: string, @Req() req: Request) {
    const userId = this.extractUserId(req);
    const sessionId = Number(id);
    if (!Number.isInteger(sessionId)) {
      throw new HttpException("无效的会话 ID", HttpStatus.BAD_REQUEST);
    }

    const session = await sessionService.getSession(sessionId);
    if (!session || session.userId !== userId) {
      throw new HttpException("会话不存在", HttpStatus.NOT_FOUND);
    }

    return { session };
  }

  // ---------- 会话消息列表 ----------

  @Get(":id/messages")
  async messages(@Param("id") id: string, @Req() req: Request) {
    const userId = this.extractUserId(req);
    const sessionId = Number(id);
    if (!Number.isInteger(sessionId)) {
      throw new HttpException("无效的会话 ID", HttpStatus.BAD_REQUEST);
    }

    // 验证会话归属
    const session = await sessionService.getSession(sessionId);
    if (!session || session.userId !== userId) {
      throw new HttpException("会话不存在", HttpStatus.NOT_FOUND);
    }

    const messages = await sessionService.getMessages(sessionId);
    return { messages };
  }

  // ---------- 更新会话标题 ----------

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() body: { title?: string },
    @Req() req: Request,
  ) {
    const userId = this.extractUserId(req);
    const sessionId = Number(id);
    if (!Number.isInteger(sessionId)) {
      throw new HttpException("无效的会话 ID", HttpStatus.BAD_REQUEST);
    }

    const session = await sessionService.getSession(sessionId);
    if (!session || session.userId !== userId) {
      throw new HttpException("会话不存在", HttpStatus.NOT_FOUND);
    }

    if (body.title) {
      await sessionService.updateSessionTitle(sessionId, body.title);
    }
    return { success: true };
  }

  // ---------- 删除会话 ----------

  @Delete(":id")
  async remove(@Param("id") id: string, @Req() req: Request) {
    const userId = this.extractUserId(req);
    const sessionId = Number(id);
    if (!Number.isInteger(sessionId)) {
      throw new HttpException("无效的会话 ID", HttpStatus.BAD_REQUEST);
    }

    const session = await sessionService.getSession(sessionId);
    if (!session || session.userId !== userId) {
      throw new HttpException("会话不存在", HttpStatus.NOT_FOUND);
    }

    await sessionService.deleteSession(sessionId);
    return { success: true };
  }
}
