import UserModel from '../models/user.model';
import CompanyModel from '../models/company.model';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP401Error from '@surefy/exceptions/HTTP401Error';
import * as bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

interface LoginCredentials {
  identifier: string; // email or phone
  password: string;
}

interface JWTPayload {
  userId: string;
  email?: string;
  phone?: string;
  role: string;
  companyId?: string;
}

class AuthService {
  private JWT_SECRET: string;
  private JWT_EXPIRES_IN: string;

  constructor() {
    this.JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
    this.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
  }

  /**
   * Login with email or phone number
   */
  async login(credentials: LoginCredentials, ipAddress: string) {
    const { identifier, password } = credentials;

    if (!identifier || !password) {
      throw new HTTP400Error({ message: 'Identifier and password are required' });
    }

    // Find user by email or phone
    const user = await UserModel.findByEmailOrPhone(identifier);

    if (!user) {
      throw new HTTP401Error({ message: 'Invalid credentials' });
    }

    // Check if user is active
    if (user.status !== 'active') {
      throw new HTTP401Error({ message: 'Account is not active' });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      throw new HTTP401Error({ message: 'Invalid credentials' });
    }

    // Get company details if user has company_id
    let company = null;
    if (user.company_id) {
      company = await CompanyModel.findById(user.company_id);
    }

    // Update last login
    await UserModel.updateLastLogin(user.id, ipAddress);

    // Generate JWT token
    const token = this.generateToken({
      userId: user.id,
      email: user.email,
      phone: user.phone,
      role: user.role,
      companyId: user.company_id,
    });

    // Remove password from response
    const { password: _, ...userWithoutPassword } = user;

    return {
      user: userWithoutPassword,
      company,
      token,
      expiresIn: this.JWT_EXPIRES_IN,
    };
  }

  /**
   * Register new user (company role)
   */
  async register(data: {
    name: string;
    email?: string;
    phone?: string;
    password: string;
  }) {
    const { name, email, phone, password } = data;

    // Validate at least email or phone is provided
    if (!email && !phone) {
      throw new HTTP400Error({ message: 'Either email or phone is required' });
    }

    // Check if user already exists
    if (email) {
      const existingUser = await UserModel.findByEmail(email);
      if (existingUser) {
        throw new HTTP400Error({ message: 'Email already registered' });
      }
    }

    if (phone) {
      const existingUser = await UserModel.findByPhone(phone);
      if (existingUser) {
        throw new HTTP400Error({ message: 'Phone number already registered' });
      }
    }

    // Hash password
    const hashedPassword = await this.hashPassword(password);

    // Create user
    const user = await UserModel.create({
      name,
      email,
      phone,
      password: hashedPassword,
      role: 'user',
      status: 'active',
    });

    // Remove password from response
    const { password: _, ...userWithoutPassword } = user;

    return userWithoutPassword;
  }

  /**
   * Create admin or superadmin user (restricted)
   */
  async createAdminUser(
    data: {
      name: string;
      email?: string;
      phone?: string;
      password: string;
      role: 'admin' | 'superadmin';
      company_id?: string;
    },
    createdBy: string,
    creatorRole: string
  ) {
    // Only superadmin can create other admins
    if (creatorRole !== 'superadmin') {
      throw new HTTP401Error({ message: 'Unauthorized to create admin users' });
    }

    const { name, email, phone, password, role, company_id } = data;

    // Validate at least email or phone is provided
    if (!email && !phone) {
      throw new HTTP400Error({ message: 'Either email or phone is required' });
    }

    // Check if user already exists
    if (email) {
      const existingUser = await UserModel.findByEmail(email);
      if (existingUser) {
        throw new HTTP400Error({ message: 'Email already registered' });
      }
    }

    if (phone) {
      const existingUser = await UserModel.findByPhone(phone);
      if (existingUser) {
        throw new HTTP400Error({ message: 'Phone number already registered' });
      }
    }

    // Hash password
    const hashedPassword = await this.hashPassword(password);

    // Create user
    const user = await UserModel.create({
      name,
      email,
      phone,
      password: hashedPassword,
      role,
      company_id,
      status: 'active',
    });

    // Remove password from response
    const { password: _, ...userWithoutPassword } = user;

    return userWithoutPassword;
  }

  /**
   * Verify JWT token
   */
  verifyToken(token: string): JWTPayload {
    try {
      return jwt.verify(token, this.JWT_SECRET) as JWTPayload;
    } catch (error) {
      throw new HTTP401Error({ message: 'Invalid or expired token' });
    }
  }

  /**
   * Generate JWT token
   */
  private generateToken(payload: JWTPayload): string {
    return jwt.sign(payload, this.JWT_SECRET, {
      expiresIn: this.JWT_EXPIRES_IN,
    } as jwt.SignOptions);
  }

  /**
   * Hash password
   */
  async hashPassword(password: string): Promise<string> {
    const saltRounds = 10;
    return bcrypt.hash(password, saltRounds);
  }

  /**
   * Change password
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await UserModel.findById(userId);

    if (!user) {
      throw new HTTP400Error({ message: 'User not found' });
    }

    // Verify current password
    const isPasswordValid = await bcrypt.compare(currentPassword, user.password);

    if (!isPasswordValid) {
      throw new HTTP401Error({ message: 'Current password is incorrect' });
    }

    // Hash new password
    const hashedPassword = await this.hashPassword(newPassword);

    // Update password
    await UserModel.changePassword(userId, hashedPassword);

    return { message: 'Password changed successfully' };
  }

  /**
   * Get user profile
   */
  async getProfile(userId: string) {
    const user = await UserModel.findById(userId);

    if (!user) {
      throw new HTTP400Error({ message: 'User not found' });
    }

    // Get company details if user has company_id
    let company = null;
    if (user.company_id) {
      company = await CompanyModel.findById(user.company_id);
    }

    // Remove password from response
    const { password: _, ...userWithoutPassword } = user;

    return {
      user: userWithoutPassword,
      company,
    };
  }
}

export default new AuthService();
