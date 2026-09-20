import { BaseModel } from '@surefy/models/base.model';

export interface ImportJobData {
  company_id: string;
  list_id?: string;
  job_type?: string;
  status?: string;
  file_name?: string;
  file_path?: string;
  file_headers?: string[];
  total_rows?: number;
  processed_rows?: number;
  successful_rows?: number;
  failed_rows?: number;
  skipped_rows?: number;
  progress_percentage?: number;
  import_options?: any;
  errors?: any[];
  result?: any;
  started_at?: Date;
  completed_at?: Date;
  failed_at?: Date;
  error_message?: string;
  error_stack?: string;
}

class ImportJobModel extends BaseModel {
  constructor() {
    super('import_jobs');
  }

  async update(jobId: string, data: Partial<ImportJobData>) {
    const jsonColumns = ['file_headers', 'import_options', 'errors', 'result'] as const;
    const updateData: any = { ...data };

    // BaseModel.update leaves arrays untouched because some tables use native
    // PostgreSQL array columns. These import_jobs columns are JSONB, so arrays
    // must be serialized explicitly before Knex sends them to PostgreSQL.
    for (const column of jsonColumns) {
      const value = updateData[column];
      if (value !== undefined && value !== null && typeof value !== 'string') {
        updateData[column] = JSON.stringify(value);
      }
    }

    return super.update(jobId, updateData);
  }

  async findByCompany(companyId: string, filters: any = {}) {
    let query = this.query()
      .where({ company_id: companyId })
      .whereNull('deleted_at');

    if (filters.user_id) query.where('user_id', filters.user_id);

    if (filters.status) {
      query = query.where({ status: filters.status });
    }

    if (filters.job_type) {
      query = query.where({ job_type: filters.job_type });
    }

    return query.orderBy('created_at', 'desc');
  }

  async findByStatus(status: string) {
    return this.query()
      .where({ status })
      .whereNull('deleted_at')
      .orderBy('created_at', 'asc');
  }

  async updateStatus(jobId: string, status: string, data: any = {}) {
    const updateData: any = { status, ...data };

    if (status === 'processing' && !data.started_at) {
      updateData.started_at = new Date();
    } else if (status === 'completed' && !data.completed_at) {
      updateData.completed_at = new Date();
    } else if (status === 'failed' && !data.failed_at) {
      updateData.failed_at = new Date();
    }

    return this.update(jobId, updateData);
  }

  async updateProgress(jobId: string, progressData: {
    processed_rows?: number;
    successful_rows?: number;
    failed_rows?: number;
    skipped_rows?: number;
    errors?: any[];
  }) {
    const job = await this.findById(jobId);
    if (!job) {
      throw new Error('Job not found');
    }

    const processed = progressData.processed_rows || job.processed_rows || 0;
    const total = job.total_rows || 1;
    const progress_percentage = Math.round((processed / total) * 100);

    const updateData = {
      ...progressData,
      progress_percentage,
    };

    return this.update(jobId, updateData);
  }

  async markAsCompleted(jobId: string, result: any) {
    return this.updateStatus(jobId, 'completed', {
      result,
      completed_at: new Date(),
      progress_percentage: 100,
    });
  }

  async markAsFailed(jobId: string, error: Error) {
    return this.updateStatus(jobId, 'failed', {
      error_message: error.message,
      error_stack: error.stack,
      failed_at: new Date(),
    });
  }

  async incrementProcessed(jobId: string, type: 'successful' | 'failed' | 'skipped' = 'successful') {
    const job = await this.findById(jobId);
    if (!job) {
      throw new Error('Job not found');
    }

    const processed_rows = (job.processed_rows || 0) + 1;
    const successful_rows = type === 'successful' ? (job.successful_rows || 0) + 1 : job.successful_rows;
    const failed_rows = type === 'failed' ? (job.failed_rows || 0) + 1 : job.failed_rows;
    const skipped_rows = type === 'skipped' ? (job.skipped_rows || 0) + 1 : job.skipped_rows;

    return this.updateProgress(jobId, {
      processed_rows,
      successful_rows,
      failed_rows,
      skipped_rows,
    });
  }

  async getActiveJobs(companyId: string) {
    return this.query()
      .where({ company_id: companyId })
      .whereIn('status', ['queued', 'processing'])
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc');
  }

  async getRecentJobs(companyId: string, limit: number = 10) {
    return this.query()
      .where({ company_id: companyId })
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc')
      .limit(limit);
  }

  async deleteByPhoneNumberId(phoneNumberId: string) {
    return this.query()
      .where({ phone_number_id: phoneNumberId })
      .del();
  }
}

export default new ImportJobModel();
