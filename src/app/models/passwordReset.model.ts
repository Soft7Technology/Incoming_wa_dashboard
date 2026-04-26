import { BaseModel } from '@surefy/models/base.model';

class PasswordResetModel extends BaseModel {
  constructor() {
    super('password_resets');
  }

  async findByOtp(otp: string,email:string) {
    return this.query().where({ otp_hash: otp,email: email }).where('expires_at', '>', new Date()).first();
  }

  async findLatestByEmail(email: string) {
    return this.query().where({ email:email }).first();
  }

  async deleteByUserId(userId: string) {
    return this.query().where({ user_id: userId }).del();
  }

}

export default new PasswordResetModel();