import UserModel from '../models/user.model';
import CompanyModel from '../models/company.model';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP401Error from '@surefy/exceptions/HTTP401Error';
import * as bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import sendEmail from '../utils';
import passwordResetModel from '../models/passwordReset.model';
import userPlansModel from '../models/userPlans.model';
import crypto from 'crypto';
import userTeamModel from '../models/team.model';

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
  ownerId?: string;
}

class AuthService {
  private JWT_SECRET: string;
  private JWT_EXPIRES_IN: string;

  constructor() {
    this.JWT_SECRET = process.env.JWT_SECRET || '1234';
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

    // Get active plan status from user_plans table
    const activePlan = await userPlansModel.getUserPlan(user.id);

    // Look up team invite permissions — if this user was invited as a team member,
    // their allowed nav keys are stored in user_team.permission
    let teamPermissions: string[] = [];
    let ownerId: string = user.id; // default: own data
    try {
      const teamRow = await userTeamModel.findOne({ email: user.email, invite_status: 'accepted' });
      if (teamRow?.permission) {
        const perm = teamRow.permission;
        // Handle both flat array ["dashboard","inbox"] and legacy {nav:[...]} shape
        if (Array.isArray(perm)) {
          teamPermissions = perm.map((p: string) => p.toLowerCase());
        } else if (Array.isArray(perm?.nav)) {
          teamPermissions = perm.nav.map((p: string) => p.toLowerCase());
        }
        // The inviter's userId — team member sees inviter's data
        ownerId = teamRow.invite_sent_by;
      }
    } catch { /* ignore — not a team member */ }

    // Update last login
    await UserModel.updateLastLogin(user.id, ipAddress);

    // Generate JWT token — include ownerId so all queries use inviter's data
    const token = this.generateToken({
      userId: user.id,
      email: user.email,
      phone: user.phone,
      role: user.role,
      companyId: user.company_id,
      ownerId,
    });

    // Remove password from response
    const { password: _, ...userWithoutPassword } = user;

    return {
      data: {
        ...userWithoutPassword,
        plan_active: activePlan ? activePlan.active : false,
        plan_name: activePlan ? activePlan.plan_name : null,
        plan_start_date: activePlan ? activePlan.start_date : null,
        plan_end_date: activePlan ? activePlan.end_date : null,
        // Include team permissions — empty array means no restriction (owner/admin)
        permissions: teamPermissions,
        owner_id: ownerId,
      },
      company,
      token,
      expiresIn: this.JWT_EXPIRES_IN,
    };
  }

  async sendOtp(email: string, otp: string) {
    // Generate OTP
    const existUser = await UserModel.findByEmail(email);
    if (!existUser) {
      throw new HTTP400Error({ message: 'User with this email does not exist' });
    }

    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');

    // Save OTP to database with expiration (e.g., 10 minutes)
    // await passwordResetModel.create(existUser.id, { otp, expiresAt: new Date(Date.now() + 10 * 60 * 1000), email });

    await passwordResetModel.create({
      user_id: existUser.id,
      otp_hash: otpHash,
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      email: email,
    });

    // Send OTP via email (implement your email service)
    await sendEmail(email, 'Your Password Reset OTP', `Your OTP is: ${otp}`);
    return { message: 'OTP sent to email' };
  }

  async verifyOtp(otp: string,email: string, ) {
    console.log('Verifying OTP for email:', email);
    const record = await passwordResetModel.findLatestByEmail(email);
    console.log('OTP Record:', record);

    if (!record) {
      throw new HTTP400Error({ message: 'Invalid request' });
    }

    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');

    if (otpHash !== record.otp_hash) {
      throw new HTTP400Error({ message: 'Invalid OTP' });
    }

    if (record.expires_at < new Date()) {
      throw new HTTP400Error({ message: 'OTP expired' });
    }

    // ✅ Mark verified
    await passwordResetModel.update(record.id, { verified: true });

    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET is not defined');
    }

    // ✅ Generate reset token
    const resetToken = jwt.sign({ userId: record.user_id }, process.env.JWT_SECRET, { expiresIn: '10m' });

    return { resetToken };
  }

  /**
   * Register new user (company role)
   */
  async register(data: {
    name: string;
    email?: string;
    phone?: string;
    company_id?: string;
    password: string;
    role: string;
  }) {
    const { name, email, phone, company_id, password } = data;

    console.log('Registering user with data:', data);

    // Validate
    if (!email && !phone) {
      throw new HTTP400Error({ message: 'Either email or phone is required' });
    }

    // Check existing
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
      company_id,
      password: hashedPassword,
      role: data.role,
      status: 'active'
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
    creatorRole: string,
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

  async resetPassword(token: string, newPassword: string) {
    let decoded;
    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET is not defined');
    }

    try {
      decoded = jwt.verify(token, this.JWT_SECRET);
    } catch {
      throw new HTTP400Error({ message: 'Invalid or expired token' });
    }

    const { userId }:any = decoded;

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await UserModel.update(userId, { password: hashedPassword });

    // cleanup
    await passwordResetModel.deleteByUserId(userId);

    return { message: 'Password reset successful' };
  }
}

export default new AuthService();