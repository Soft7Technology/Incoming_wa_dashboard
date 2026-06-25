import { BaseModel } from '@surefy/models/base.model';

class PipelineStageModel extends BaseModel {
  constructor() {
    super('pipeline_stages');
  }

  async findByUser(userId: string) {
    return this.query()
      .where({ user_id: userId })
      .whereNull('deleted_at')
      .orderBy('position', 'asc');
  }

  async findByCompany(companyId: string) {
    return this.query()
      .where({ company_id: companyId })
      .whereNull('deleted_at')
      .orderBy('position', 'asc');
  }
}

export default new PipelineStageModel();
