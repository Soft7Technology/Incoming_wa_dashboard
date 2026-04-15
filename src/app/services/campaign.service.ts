import CampaignModel from '../models/campaign.model';
import CampaignMessageModel from '../models/campaignMessage.model';
import ContactService from './contact.service';
import TemplateModel from '../models/template.model';
import MessageService from './message.service';
import MetaService from './meta.service';
import ContactModel from '../models/contact.model';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import { campaignExecutionQueue } from '../../queues/campaignExecution.queue';
import * as fs from 'fs';
import campaignModel from '../models/campaign.model';
import { v4 as uuidv4 } from "uuid";



interface CreateCampaignData {
  name: string;
  description?: string;
  phone_number_id: string;
  template_id: string;
  contact_filters?: {
    tag_ids?: string[];
    list_ids?: string[];
    exclude_invalid?: boolean;
    attributes?: Record<string, any>;
  };
  parameter_mapping?: Record<string, string>; // template_param -> contact_attribute
  media_uploads?: Array<{ type: string; media_id: string; url?: string }>;
  scheduled_at?: Date | 'now';
}

class CampaignService {
  /**
   * Create a new campaign
   */
  async createCampaign(userId:string,companyId:string, data: CreateCampaignData) {
    // Verify template exists
    const template = await TemplateModel.findById(data.template_id);
    if (!template || template.user_id !== userId) {
      throw new HTTP404Error({ message: 'Template not found' });
    }

    console.log("Data",data)

    if (template.status !== 'APPROVED') {
      throw new HTTP400Error({ message: 'Template must be approved before use in campaigns' });
    }

    // Get contacts based on filters
    const contacts = await ContactService.getContactsByFilters(userId,companyId, data.contact_filters || {});
    const contactList = await contacts;
    console.log('Found contacts for campaign:', contactList);

    if (contactList.length === 0) {
      throw new HTTP400Error({ message: 'No contacts found matching the specified filters' });
    }

    // Determine scheduled time
    let scheduledAt: Date | null = null;
    let status = 'draft';

    if (data.scheduled_at) {
      if (data.scheduled_at === 'now') {
        // Schedule 5 minutes from now
        // scheduledAt = new Date(Date.now() + 5 * 60 * 1000);
        scheduledAt = new Date(Date.now() + 1 * 60 * 1000);
        status = 'scheduled';
      } else {
        scheduledAt = new Date(data.scheduled_at);
        status = 'scheduled';
      }
    }

    console.log("Schedule", scheduledAt);

    // Create campaign
    const campaign = await CampaignModel.create({
      user_id:userId,
      company_id:companyId,
      phone_number_id: data.phone_number_id,
      template_id: data.template_id,
      name: data.name,
      description: data.description,
      status,
      total_recipients: contactList.length,
      template_params: template.components,
      parameter_mapping: data.parameter_mapping || {},
      media_uploads: data.media_uploads || [],
      contact_filters: data.contact_filters || {},
      scheduled_at: scheduledAt,
    });

    // Create campaign_messages entries for each contact
    const campaignMessages = contactList.map((contact) => ({
      campaign_id: campaign.id,
      contact_id: contact.id,
      status: 'pending',
      template_variables: this.resolveTemplateVariables(
        contact,
        data.parameter_mapping || {}
      ),
    }));

    await CampaignMessageModel.bulkCreate(campaignMessages);

    return campaign;
  }

  /**
   * Resolve template variables from contact attributes
   */
  private resolveTemplateVariables(contact: any, mapping: Record<string, string>): Record<string, any> {
    const variables: Record<string, any> = {};

    for (const [templateParam, contactAttribute] of Object.entries(mapping)) {
      if (contactAttribute === 'fullName') {
        variables[templateParam] = contact.name || '';
      } else if (contactAttribute === 'phone_number') {
        variables[templateParam] = contact.phone_number || '';
      } else if (contactAttribute === 'email') {
        variables[templateParam] = contact.email || '';
      } else if (contact.attributes && contact.attributes[contactAttribute]) {
        variables[templateParam] = contact.attributes[contactAttribute];
      } else {
        variables[templateParam] = contactAttribute;
      }
    }

    return variables;
  }

  /**
   * Get campaign by ID
   */
  async getCampaignById(campaignId: string) {
    const campaign = await CampaignModel.findById(campaignId);
    if (!campaign) {
      throw new HTTP404Error({ message: 'Campaign not found' });
    }

    // Get stats
    const stats = await CampaignMessageModel.getCampaignStats(campaignId);
    campaign.stats = stats;

    return campaign;
  }

  /**
   * Get all campaigns for a company
   */
  async getCampaigns(userId:string, filters: any = {}) {
    const page = parseInt(filters.page) || 1;
    const limit = parseInt(filters.limit) || 20;
    const offset = (page - 1) * limit;

    let campaigns = await CampaignModel.findByCompany(userId, filters);

    const total = campaigns.length;
    campaigns = campaigns.slice(offset, offset + limit);

    return { campaigns, total, page, limit };
  }

  /**
   * Start campaign execution (queued in background)
   */
  async startCampaign(campaignId: string) {
    const campaign = await CampaignModel.findById(campaignId);
    console.log('Starting campaign:', campaign);
    if (!campaign) {
      throw new HTTP404Error({ message: 'Campaign not found' });
    }

    if (campaign.status !== 'scheduled' && campaign.status !== 'draft' && campaign.status !== 'paused') {
      throw new HTTP400Error({ message: `Campaign in status '${campaign.status}' cannot be started` });
    }

    // Queue campaign execution in background worker
    await campaignExecutionQueue.add(
      `campaign-${campaignId}`,
      {
        campaignId: campaignId,
        userId: campaign.user_id,
        companyId: campaign.company_id,
      },
      {
        jobId: campaignId, // Use campaign ID as job ID for easy tracking
      }
    );

    return {
      message: 'Campaign queued for execution successf',
      campaign_id: campaignId,
      status: 'queued'
    };
  }

  /**
   * Execute campaign - send messages to all pending contacts
   * Includes dynamic batch sizing based on server CPU and RAM usage
   */
  private async executeCampaign(campaignId: string) {
    const campaign = await CampaignModel.findById(campaignId);
    if (!campaign) return;

    // Dynamic batch sizing configuration
    let batchSize = 200; // Initial batch size
    const minBatchSize = 2; // Minimum batch size
    const maxBatchSize = 500; // Maximum batch size
    const delayBetweenBatches = 2; // Base delay: 2 seconds between batches

    // Resource thresholds
    const cpuThresholdHigh = 80; // % - Reduce batch size if CPU > 80%
    const cpuThresholdLow = 50; // % - Increase batch size if CPU < 50%
    const memThresholdHigh = 85; // % - Reduce batch size if memory > 85%
    const memThresholdLow = 60; // % - Increase batch size if memory < 60%

    let hasMore = true;

    while (hasMore) {
      // Check if campaign is still running
      const currentCampaign = await CampaignModel.findById(campaignId);
      if (currentCampaign.status !== 'running') {
        console.log(`Campaign ${campaignId} stopped, status: ${currentCampaign.status}`);
        break;
      }

      // Monitor server resources and adjust batch size
      const resources = this.getServerResources();
      const cpuUsage = resources.cpuUsage;
      const memUsage = resources.memUsage;

      console.log(`[Campaign ${campaignId}] CPU: ${cpuUsage.toFixed(1)}%, Memory: ${memUsage.toFixed(1)}%, Batch Size: ${batchSize}`);

      // Adjust batch size based on resource usage
      if (cpuUsage > cpuThresholdHigh || memUsage > memThresholdHigh) {
        // High resource usage - reduce batch size
        batchSize = Math.max(minBatchSize, Math.floor(batchSize * 0.7));
        console.log(`[Campaign ${campaignId}] High resource usage detected. Reducing batch size to ${batchSize}`);
      } else if (cpuUsage < cpuThresholdLow && memUsage < memThresholdLow) {
        // Low resource usage - increase batch size
        batchSize = Math.min(maxBatchSize, Math.floor(batchSize * 1.3));
        console.log(`[Campaign ${campaignId}] Low resource usage. Increasing batch size to ${batchSize}`);
      }

      // Emergency brake: If resources are critically high, pause for longer
      if (cpuUsage > 90 || memUsage > 95) {
        console.warn(`[Campaign ${campaignId}] CRITICAL resource usage! CPU: ${cpuUsage.toFixed(1)}%, Memory: ${memUsage.toFixed(1)}%. Pausing for 10 seconds...`);
        await new Promise((resolve) => setTimeout(resolve, 10000));
        batchSize = minBatchSize; // Reset to minimum batch size
        continue; // Skip this iteration and re-check resources
      }

      // Get pending messages
      const pendingMessages = await CampaignMessageModel.getPendingMessages(campaignId, batchSize);

      if (pendingMessages.length === 0) {
        hasMore = false;
        await CampaignModel.updateStatus(campaignId, 'completed');
        break;
      }

      // Send messages in parallel (batch)
      await Promise.all(
        pendingMessages.map((campaignMessage) =>
          this.sendCampaignMessage(campaign, campaignMessage)
        )
      );

      // Dynamic delay based on resource usage
      let delay = delayBetweenBatches;
      if (cpuUsage > cpuThresholdHigh || memUsage > memThresholdHigh) {
        // Increase delay if resources are high
        delay = delayBetweenBatches * 2;
      }

      // Delay between batches to avoid rate limiting and resource overload
      if (pendingMessages.length === batchSize) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Get current server CPU and RAM usage
   */
  private getServerResources(): { cpuUsage: number; memUsage: number } {
    const os = require('os');

    // Calculate CPU usage
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach((cpu: any) => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });

    const cpuUsage = 100 - (100 * totalIdle) / totalTick;

    // Calculate memory usage
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsage = (usedMem / totalMem) * 100;

    return {
      cpuUsage: Math.max(0, Math.min(100, cpuUsage)), // Clamp between 0-100
      memUsage: Math.max(0, Math.min(100, memUsage)), // Clamp between 0-100
    };
  }

  /**
   * Send individual campaign message
   */
  private async sendCampaignMessage(campaign: any, campaignMessage: any) {
    try {
      // Get contact
      const contact = await ContactModel.findById(campaignMessage.contact_id);
      if (!contact) {
        await CampaignMessageModel.updateStatus(campaignMessage.id, 'skipped', {
          error_message: 'Contact not found',
        });
        return;
      }

      // Skip invalid numbers
      if (!contact.is_valid) {
        await CampaignMessageModel.updateStatus(campaignMessage.id, 'skipped', {
          error_message: `Invalid number: ${contact.invalid_reason}`,
        });
        await CampaignModel.incrementCount(campaign.id, 'invalid_numbers_count');
        return;
      }

      // Get template
      const template = await TemplateModel.findById(campaign.template_id);
      if (!template) {
        throw new Error('Template not found');
      }

      // Build template payload
      const templatePayload = this.buildTemplatePayload(
        template,
        campaignMessage.template_variables,
        campaign.media_uploads
      );
      const messageUUID = uuidv4();

      // // Send message via MessageService
      const message = await MessageService.sendMessage({
        messageUUID,
        user_id: campaign.user_id,
        campaign_id: campaign.id,
        profile_name: contact.name,
        phone_number_id: campaign.phone_number_id,
        to: contact.phone_number,
        type: 'template',
        template: templatePayload,
      });

      // Update campaign message status
      await CampaignMessageModel.updateStatus(campaignMessage.id, 'sent', {
        message_id: message.id,
      });

      // Update campaign counts
      await CampaignModel.incrementCount(campaign.id, 'sent_count');
      await CampaignModel.updateCounts(campaign.id, {
        total_cost: Number(campaign.total_cost || 0) + Number(message.cost || 0),
      });

      // // Update contact stats
      await ContactModel.incrementMessageCount(contact.id);
    } catch (error: any) {
      console.error(`Failed to send campaign message ${campaignMessage.id}:`, error);

      await CampaignMessageModel.updateStatus(campaignMessage.id, 'failed', {
        error_message: error?.message || 'Unknown error',
        error_code: error?.code || 'UNKNOWN',
      });

      await CampaignModel.incrementCount(campaign.id, 'failed_count');

      // Update contact failed count
      if (campaignMessage.contact_id) {
        await ContactModel.incrementFailedCount(campaignMessage.contact_id);
      }
    }
  }

  /**
   * Build template payload with variables
   */
  private buildTemplatePayload(template: any, variables: Record<string, any>, mediaUploads: any[] = []) {
    const components = [];
    console.log('Building template payload with variables:', variables, template, mediaUploads)

    // Process template components
    if (template.components) {
      for (const component of template.components) {
        if (component.type === 'HEADER' && component.format === 'IMAGE') {
          const media = mediaUploads.find((m) => m.type === 'image');
          console.log('Media uploads:', mediaUploads, media);
          if (media) {
            components.push({
              type: 'header',
              parameters: [
                {
                  type: 'image',
                  image: {
                    id: media.media_id,
                  },
                },
              ],
            });
          } else if (component.example?.header_handle?.[0]) {
            // Use the template's example image URL if no media uploaded
            components.push({
              type: 'header',
              parameters: [
                {
                  type: 'image',
                  image: {
                    link: component.example.header_handle[0],
                  },
                },
              ],
            });
          }
        } else if (component.type === 'HEADER' && component.format === 'VIDEO') {
          const media = mediaUploads.find((m) => m.type === 'video');
          if (media) {
            components.push({
              type: 'header',
              parameters: [
                {
                  type: 'video',
                  video: {
                    id: media.media_id,
                  },
                },
              ],
            });
          } else if (component.example?.header_handle?.[0]) {
            // Use the template's example video URL if no media uploaded
            components.push({
              type: 'header',
              parameters: [
                {
                  type: 'video',
                  video: {
                    link: component.example.header_handle[0],
                  },
                },
              ],
            });
          }
        } else if (component.type === 'HEADER' && component.format === 'DOCUMENT') {
          const media = mediaUploads.find((m) => m.type === 'document');
          if (media) {
            components.push({
              type: 'header',
              parameters: [
                {
                  type: 'document',
                  document: {
                    id: media.media_id,
                  },
                },
              ],
            });
          } else if (component.example?.header_handle?.[0]) {
            // Use the template's example document URL if no media uploaded
            components.push({
              type: 'header',
              parameters: [
                {
                  type: 'document',
                  document: {
                    link: component.example.header_handle[0],
                  },
                },
              ],
            });
          }
        } else if (component.type === 'BODY' && component.text) {
          // Extract variables from body text {{1}}, {{2}}, etc.
          const bodyVariables = this.extractTemplateVariables(component.text);
          if (bodyVariables.length > 0) {
            const parameters = bodyVariables.map((varName) => ({
              type: 'text',
              text: variables[varName] || '',
            }));

            components.push({
              type: 'body',
              parameters,
            });
          }
        }
      }
    }

    return {
      name: template.name,
      language: template.language,
      components: components.length > 0 ? components : undefined,
    };
  }

  /**
   * Extract template variables from text
   */
  private extractTemplateVariables(text: string): string[] {
    const regex = /\{\{(\d+)\}\}/g;
    const matches = [];
    let match;

    while ((match = regex.exec(text)) !== null) {
      matches.push(match[1]);
    }

    return matches;
  }

  /**
   * Pause campaign
   */
  async pauseCampaign(campaignId: string) {
    const campaign = await CampaignModel.findById(campaignId);
    if (!campaign) {
      throw new HTTP404Error({ message: 'Campaign not found' });
    }

    if (campaign.status !== 'running') {
      throw new HTTP400Error({ message: 'Only running campaigns can be paused' });
    }

    await CampaignModel.updateStatus(campaignId, 'paused');
    return { message: 'Campaign paused successfully' };
  }

  /**
   * Resume campaign (re-queue for execution)
   */
  async resumeCampaign(campaignId: string) {
    const campaign = await CampaignModel.findById(campaignId);
    console.log('Resuming campaign:', campaign);
    if (!campaign) {
      throw new HTTP404Error({ message: 'Campaign not found' });
    }

    if (campaign.status !== 'paused') {
      //campaign status update to running
      throw new HTTP400Error({ message: 'Only paused campaigns can be resumed' });
    }

    await CampaignModel.updateStatus(campaignId, 'running');

    //Execute Campaign
    this.executeCampaign(campaignId)

    // // Re-queue campaign execution
    // await campaignExecutionQueue.add(
    //   `campaign-${campaignId}`,
    //   {
    //     campaignId,
    //     companyId: campaign.company_id,
    //   },
    //   {
    //     jobId: campaignId,
    //   }
    // );

    return {
      message: 'Campaign queued for resumption successfully',
      campaign_id: campaignId,
    };
  }

  /**
   * Test campaign - send to a single test number
   */
  async testCampaign(campaignId: string, testPhoneNumber: string) {
    const campaign = await CampaignModel.findById(campaignId);
    if (!campaign) {
      throw new HTTP404Error({ message: 'Campaign not found' });
    }

    // Get template
    const template = await TemplateModel.findById(campaign.template_id);
    if (!template) {
      throw new HTTP404Error({ message: 'Template not found' });
    }

    // Create a mock contact for testing
    const mockContact = {
      phone_number: testPhoneNumber,
      name: 'Test User',
      email: 'test@example.com',
      attributes: {},
    };

    // Resolve variables
    const variables = this.resolveTemplateVariables(mockContact, campaign.parameter_mapping || {});

    // Build template payload
    const templatePayload = this.buildTemplatePayload(template, variables, campaign.media_uploads);

    const messageUUID = uuidv4();

    // Send test message
    const message = await MessageService.sendMessage({
      messageUUID,
      user_id: campaign.user_id,
      campaign_id: campaign.id,
      phone_number_id: campaign.phone_number_id,
      to: testPhoneNumber,
      type: 'template',
      template: templatePayload,
    });

    return {
      message: 'Test message sent successfully',
      message_id: message.id,
      variables,
      template: templatePayload,
    };
  }

  /**
   * Get campaign execution progress
   */
  async getCampaignProgress(campaignId: string) {
    const campaign = await CampaignModel.findById(campaignId);
    if (!campaign) {
      throw new HTTP404Error({ message: 'Campaign not found' });
    }

    // Get job progress from BullMQ if campaign is running
    let jobProgress = null;
    if (campaign.status === 'running' || campaign.status === 'queued') {
      const job = await campaignExecutionQueue.getJob(campaignId);
      if (job) {
        jobProgress = {
          progress: await job.progress,
          state: await job.getState(),
        };
      }
    }

    const stats = await CampaignMessageModel.getCampaignStats(campaignId);

    return {
      campaign_id: campaignId,
      status: campaign.status,
      progress_percentage: jobProgress?.progress || 0,
      job_state: jobProgress?.state || null,
      total_recipients: campaign.total_recipients,
      sent_count: campaign.sent_count || 0,
      delivered_count: campaign.delivered_count || 0,
      read_count: campaign.read_count || 0,
      failed_count: campaign.failed_count || 0,
      invalid_numbers_count: campaign.invalid_numbers_count || 0,
      pending_count: stats.pending || 0,
      stats,
    };
  }

  /**
   * Get campaign messages info
   */
  async getCampaignMessagesInfo(campaignId: string, status?: string | undefined,page?:number,pageSize?:number) {
    const campaign = await CampaignModel.findById(campaignId);
    if (!campaign) {
      throw new HTTP404Error({ message: 'Campaign not found' });
    }

    const messagesInfo = await CampaignMessageModel.getCampaignMessageStatus(campaignId, status,page,pageSize);
    return messagesInfo;
  }

  /**
   * Campaign Button Click Rate
   */
  async buttonClickRateInfo(campaignId:string,page?:number,pageSize?:number){
    const campaign = await CampaignModel.findById(campaignId)
    if(!campaign){
      throw new HTTP404Error({ message: 'Campaign not found' });
    }

    const messageInfo = await CampaignMessageModel.buttonClickRateInfo(campaignId,page,pageSize)
    return messageInfo
  }

  /**
   * Failure Stats
   */
  async failureMessageStats(campaignId:string){
    const campaign = await CampaignModel.findById(campaignId)
    if(!campaign){
      throw new HTTP404Error({ message: 'Campaign not found' });
    }
    const failureStats = await CampaignMessageModel.failureMessageStats(campaignId)
    return failureStats
  }

  async failureMessageInfo(campaignId:string,error:any,page?:number,pageSize?:number){
    const campaign = await CampaignModel.findById(campaignId)
    if(!campaign){
      throw new HTTP404Error({ message: 'Campaign not found' });
    }
    const failureStats = await CampaignMessageModel.failureMessageInfo(campaignId,error,page,pageSize)
    return failureStats
  }


  /**
   * Get campaign statistics
   */
  async getCampaignStats(campaignId: string) {
    const campaign = await CampaignModel.findById(campaignId);
    if (!campaign) {
      throw new HTTP404Error({ message: 'Campaign not found' });
    }

    const stats = await CampaignMessageModel.getCampaignStats(campaignId);

    return {
      campaign_id: campaignId,
      name: campaign.name,
      status: campaign.status,
      total_recipients: campaign.total_recipients,
      sent_count: stats.sent_count,
      delivered_count: stats.delivered_count,
      read_count: stats.read_count,
      failed_count: stats.failed_count,
      invalid_numbers_count: campaign.invalid_numbers_count,
      total_cost: stats.total_cost,
      scheduled_at: campaign.scheduled_at,
      started_at: campaign.started_at,
      completed_at: campaign.completed_at,
      detailed_stats: stats,
    };
  }

  /**
   * Delete campaign
   */
  async deleteCampaign(campaignId: string) {
    const campaign = await CampaignModel.findById(campaignId);
    if (!campaign) {
      throw new HTTP404Error({ message: 'Campaign not found' });
    }

    if (campaign.status === 'running') {
      throw new HTTP400Error({ message: 'Cannot delete a running campaign. Please pause it first.' });
    }

    await CampaignModel.delete(campaignId);
    return { message: 'Campaign deleted successfully' };
  }

  /**
   * Upload media for campaign template
   */
  async uploadMedia(companyId: string, phoneNumberId: string, file: any, type: string) {
    // Upload to Meta
    const metaResponse = await MetaService.uploadMedia(phoneNumberId, file, type);

    return {
      media_id: metaResponse.id,
      type,
    };
  }

  /**
   * Process campaign message status updates from webhooks
   */
  async handleMessageStatusUpdate(messageId: string, status: string, timestamp: Date) {
    // Find campaign message
    const campaignMessage = await CampaignMessageModel.findByMessageId(messageId);

    if (!campaignMessage) {
      return; // Not a campaign message
    }

    // Update campaign message status
    const statusMap: Record<string, string> = {
      sent: 'sent',
      delivered: 'delivered',
      read: 'read',
      failed: 'failed',
    };

    const newStatus = statusMap[status];
    if (!newStatus) return;

    await CampaignMessageModel.updateStatus(campaignMessage.id, newStatus, {
      [`${status}_at`]: timestamp,
    });

    // Update campaign counts
    const campaign = await CampaignModel.findById(campaignMessage.campaign_id);
    if (!campaign) return;

    if (status === 'delivered') {
      await CampaignModel.incrementCount(campaign.id, 'delivered_count');
    } else if (status === 'read') {
      await CampaignModel.incrementCount(campaign.id, 'read_count');
    }
  }

  /**
   * Handle invalid WhatsApp number detection from webhook
   */
  async handleInvalidNumber(contactId: string, reason: string = 'not_whatsapp') {
    await ContactModel.markAsInvalid(contactId, reason);

    // Update campaign stats for all campaigns with this contact
    const campaignMessages = await CampaignMessageModel.findPendingByContactId(contactId);

    for (const cm of campaignMessages) {
      await CampaignMessageModel.updateStatus(cm.id, 'skipped', {
        error_message: `Number marked as invalid: ${reason}`,
      });

      await CampaignModel.incrementCount(cm.campaign_id, 'invalid_numbers_count');
    }
  }
}

export default new CampaignService();