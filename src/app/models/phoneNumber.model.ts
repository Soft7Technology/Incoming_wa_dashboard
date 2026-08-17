import { BaseModel } from '@surefy/models/base.model';
import { validate as uuidValidate } from 'uuid';

class PhoneNumberModel extends BaseModel {
  constructor() {
    super('phone_numbers');
  }

  async findByCompanyId(companyId: string) {
    return this.query().where({ company_id: companyId, deleted_at: null });
  }

  // async findByUserId(userId?: string, companyId?: string) {
  //   const shouldUseCompanyId =
  //     companyId &&
  //     companyId !== 'ae815512-cf4b-4e7e-8472-16d3c2d4bb18';

  //   return this.query()
  //     .whereNull('deleted_at')
  //     .andWhere((qb) => {
  //       if (userId && shouldUseCompanyId) {
  //         qb.where('user_id', userId).orWhere('company_id', companyId);
  //       } else if (userId) {
  //         qb.where('user_id', userId);
  //       } else if (shouldUseCompanyId) {
  //         qb.where('company_id', companyId);
  //       }
  //     });
  // }

  async findByUserId(
    userId?: string,
    companyId?: string
  ) {
    const shouldUseCompanyId =
      companyId &&
      companyId !==
      "ae815512-cf4b-4e7e-8472-16d3c2d4bb18";

    return this.query()
      .leftJoin(
        "waba_accounts as wa",
        "phone_numbers.waba_id",
        "wa.id"
      )
      .whereNull("phone_numbers.deleted_at")
      .andWhere((qb) => {
        if (userId && shouldUseCompanyId) {
          qb.where("phone_numbers.user_id", userId)
            .orWhere(
              "phone_numbers.company_id",
              companyId
            );
        } else if (userId) {
          qb.where(
            "phone_numbers.user_id",
            userId
          );
        } else if (shouldUseCompanyId) {
          qb.where(
            "phone_numbers.company_id",
            companyId
          );
        }
      })
      .select(
        "phone_numbers.*",
        "wa.waba_id"
      );
  }


  async findByPhoneNumberId(phoneNumberId: any) {
    console.log('Finding phone number with ID:', phoneNumberId); // Debug log
    if (!phoneNumberId) return null;
    const isUuid = typeof phoneNumberId === 'string' && uuidValidate(phoneNumberId);
    return this.query()
      .where((qb) => {
        qb.where('phone_number_id', phoneNumberId);
        if (isUuid) {
          qb.orWhere('id', phoneNumberId);
        }
      })
      .andWhere({ deleted_at: null })
      .first();
  }

  async findByPhoneId(phoneNumberId: string) {
    return this.query().where({ id: phoneNumberId }).first();
  }

  async findByWabaId(wabaId: string) {
    return this.query().where({ waba_id: wabaId, deleted_at: null });
  }
}

export default new PhoneNumberModel();
