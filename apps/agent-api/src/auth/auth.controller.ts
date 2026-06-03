import { Body, Controller, HttpCode, HttpException, HttpStatus, Post } from "@nestjs/common";
import { opensourceAuthConfig } from "../config.js";
import { AuthService } from "./auth.service.js";
import { signHs256Jwt } from "./jwt.js";

interface LoginRequest {
  phone?: string;
  password?: string;
}

interface RegisterRequest {
  phone?: string;
  password?: string;
  username?: string;
  nickname?: string;
}

/**
 * 开源版认证接口：
 * - 使用本地 SQLite users 表完成注册与登录
 * - 登录成功后签发本服务 JWT
 */
@Controller("api/v1/users")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("register")
  @HttpCode(200)
  async register(@Body() body: RegisterRequest) {
    const phone = body.phone?.trim() ?? "";
    const password = body.password ?? "";
    const username = body.username?.trim() || phone;
    const nickname = body.nickname?.trim() || username;

    if (!phone || !password) {
      throw new HttpException("请输入手机号和密码", HttpStatus.BAD_REQUEST);
    }

    const phonePattern = /^1\d{10}$/;
    if (!phonePattern.test(phone)) {
      throw new HttpException("手机号格式不正确", HttpStatus.BAD_REQUEST);
    }

    if (password.length < 6) {
      throw new HttpException("密码长度不能少于 6 位", HttpStatus.BAD_REQUEST);
    }

    const exists = await this.authService.findByPhone(phone);
    if (exists) {
      throw new HttpException("手机号已注册", HttpStatus.CONFLICT);
    }

    const user = await this.authService.register({
      phone,
      password,
      username,
      nickname,
    });

    return {
      code: 200,
      message: "注册成功",
      user,
    };
  }

  @Post("login")
  @HttpCode(200)
  async login(@Body() body: LoginRequest) {
    const phone = body.phone?.trim() ?? "";
    const password = body.password ?? "";

    if (!phone || !password) {
      throw new HttpException("请输入手机号和密码", HttpStatus.BAD_REQUEST);
    }

    const user = await this.authService.verifyLogin(phone, password);
    if (!user) {
      throw new HttpException("手机号或密码错误", HttpStatus.UNAUTHORIZED);
    }

    const token = signHs256Jwt({
      userId: user.id,
      username: user.username,
      expiresInSeconds: opensourceAuthConfig.expiresInHours * 3600,
    });

    return {
      code: 200,
      message: "登录成功",
      token,
      user,
      data: {
        token,
      },
    };
  }
}
