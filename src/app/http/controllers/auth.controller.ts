import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import AuthService from '@surefy/console/services/auth.service';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';

export interface JWTRequest extends Request {
  userId?: string;
  userRole?: string;
  companyId?: string;
}

class AuthController {
  /**
   * POST /v1/auth/login
   * Login with email or phone
   */
  login = tryCatchAsync(async (req: Request, res: Response) => {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      throw new HTTP400Error({ message: 'Identifier (email or phone) and password are required' });
    }

    const ipAddress = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '';

    const result = await AuthService.login({ identifier, password }, ipAddress);

    return successResponse(req, res, 'Login successful', result);
  });

  /**
   * POST /v1/auth/register
   * Register new company user
   */
  register = tryCatchAsync(async (req: Request, res: Response) => {
    const { name, email, phone, password } = req.body;

    if (!name || !password) {
      throw new HTTP400Error({ message: 'Name and password are required' });
    }

    if (!email && !phone) {
      throw new HTTP400Error({ message: 'Either email or phone is required' });
    }

    const user = await AuthService.register({
      name,
      email,
      phone,
      password
    });

    return successResponse(req, res, 'User registered successfully', user, HttpStatusCode.CREATED);
  });

  /**
   * POST /v1/auth/create-admin
   * Create admin/superadmin user (superadmin only)
   */
  createAdmin = tryCatchAsync(async (req: JWTRequest, res: Response) => {
    const { name, email, phone, password, role, company_id } = req.body;

    if (!name || !password || !role) {
      throw new HTTP400Error({ message: 'Name, password, and role are required' });
    }

    if (!email && !phone) {
      throw new HTTP400Error({ message: 'Either email or phone is required' });
    }

    if (role !== 'admin' && role !== 'superadmin') {
      throw new HTTP400Error({ message: 'Role must be either admin or superadmin' });
    }

    const user = await AuthService.createAdminUser(
      {
        name,
        email,
        phone,
        password,
        role,
        company_id,
      },
      req.userId!,
      req.userRole!
    );

    return successResponse(req, res, `${role} user created successfully`, user, HttpStatusCode.CREATED);
  });

  /**
   * GET /v1/auth/profile
   * Get current user profile
   */
  getProfile = tryCatchAsync(async (req: JWTRequest, res: Response) => {
    const result = await AuthService.getProfile(req.userId!);
    return successResponse(req, res, 'Profile retrieved successfully', result);
  });

  /**
   * POST /v1/auth/change-password
   * Change user password
   */
  changePassword = tryCatchAsync(async (req: JWTRequest, res: Response) => {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      throw new HTTP400Error({ message: 'Current password and new password are required' });
    }

    if (new_password.length < 6) {
      throw new HTTP400Error({ message: 'New password must be at least 6 characters long' });
    }

    const result = await AuthService.changePassword(req.userId!, current_password, new_password);

    return successResponse(req, res, result.message);
  });
}

export default new AuthController();
