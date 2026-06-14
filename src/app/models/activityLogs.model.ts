import { BaseModel } from '@surefy/models/base.model';

class ActivityLogsModel extends BaseModel {
  constructor() {
    super('activity_logs');
  }
}

export default new ActivityLogsModel();