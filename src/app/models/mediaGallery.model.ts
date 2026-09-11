import { BaseModel } from '@surefy/models/base.model';

class MediaGalleryModel extends BaseModel {
  constructor() {
    super('media_gallery');
  }

  async findByUserId(userId: string) {
    return this.query()
      .where({ user_id: userId })
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc');
  }

  async findByIdAndUserId(id: string, userId: string) {
    return this.query()
      .where({
        id,
        user_id: userId,
      })
      .whereNull('deleted_at')
      .first();
  }
}

export default new MediaGalleryModel();