import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import WabaService from '@surefy/console/services/waba.service';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import wabaService from '@surefy/console/services/waba.service';

class WabaController {
  /**
   * POST /v1/waba
   * Create WABA account
   */
  createWaba = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { waba_id, name, currency, timezone, meta_data } = req.body;
    console.log("Creating WABA with data:", req.companyId);

    if (!waba_id) {
      throw new HTTP400Error({ message: 'WABA ID is required' });
    }

    const waba = await WabaService.createWaba({
      user_id: req.userId!,
      company_id: req.companyId!,
      waba_id,
      name,
      currency,
      timezone,
      meta_data,
    });

    return successResponse(req, res, 'WABA account created successfully', waba, HttpStatusCode.CREATED);
  });

  /**
   * 
   */
  onboardingWaba = tryCatchAsync(async(req:AuthRequest,res:Response)=>{
    const {waba_id} = req.body
    console.log("Onboarding WABA with data:", req.body);  
    console.log("Onboarding WABA with data:",waba_id);
    if(!waba_id){
      throw new HTTP400Error({ message: 'WABA ID is required' });
    }

    const waba = await wabaService.onboardWaba({
      user_id: req.userId!,
      company_id: req.companyId!,
      waba_id
    })
    return successResponse(req, res, 'WABA account created successfully', waba, HttpStatusCode.CREATED);
  })

  /**
   * GET /v1/waba
   * Get all WABA accounts for company
   */
  getWabas = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const wabas = await WabaService.getCompanyWabas(req.userId!);
    return successResponse(req, res, 'WABA accounts retrieved successfully', wabas);
  });

  /**
   * POST /v1/waba/:wabaId/phone-numbers
   * Add phone number to WABA
   */
  addPhoneNumber = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { wabaId } = req.params;
    const { phone_number_id, display_phone_number, capabilities } = req.body;

    if (!phone_number_id || !display_phone_number) {
      throw new HTTP400Error({ message: 'Phone number ID and display phone number are required' });
    }

    const phoneNumber = await WabaService.addPhoneNumber({
      company_id: req.companyId!,
      waba_id: wabaId,
      phone_number_id,
      display_phone_number,
      capabilities,
    });

    return successResponse(req, res, 'Phone number added successfully', phoneNumber, HttpStatusCode.CREATED);
  });

  /**
   * GET /v1/waba/phone-numbers
   * Get all phone numbers for company
   */
  getPhoneNumbers = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const phoneNumbers = await WabaService.getUserPhoneNumbers(req.userId!);
    return successResponse(req, res, 'Phone numbers retrieved successfully', phoneNumbers);
  });

  /**
   * GET /v1/waba/:wabaId/phone-numbers
   * Get phone numbers for specific WABA
   */
  getWabaPhoneNumbers = tryCatchAsync(async (req: Request, res: Response) => {
    const { wabaId } = req.params;
    const phoneNumbers = await WabaService.getWabaPhoneNumbers(wabaId);
    return successResponse(req, res, 'Phone numbers retrieved successfully', phoneNumbers);
  });

  /**
   * POST /v1/waba/:wabaId/sync-phone-numbers
   * Sync phone numbers from Meta
   */
  syncPhoneNumbers = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { wabaId } = req.params;
    const synced = await WabaService.syncPhoneNumbers(req.companyId!, wabaId);
    return successResponse(req, res, `${synced.length} phone numbers synced successfully`, synced);
  });

  /**
   * PUT /v1/waba/phone-numbers/:id
   * Update phone number
   */
  updatePhoneNumber = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const phoneNumber = await WabaService.updatePhoneNumber(id, req.body);
    return successResponse(req, res, 'Phone number updated successfully', phoneNumber);
  });

  /**
   * DELETE /v1/waba/phone-numbers/:id
   * Delete phone number
   */
  deletePhoneNumber = tryCatchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    await WabaService.deletePhoneNumber(id);
    return successResponse(req, res, 'Phone number deleted successfully');
  });
}

export default new WabaController();
