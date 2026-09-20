import { accountScope, ownedResource, ownedPhone } from '../app/http/middleware/accountScope';
import { Router } from 'express';
import WabaController from '@surefy/console/http/controllers/waba.controller';
import wabaController from '@surefy/console/http/controllers/waba.controller';

const WabaRoute = Router();
WabaRoute.use(accountScope);

// All WABA endpoints require authentication (applied at route group level)

WabaRoute.post('/onboard', WabaController.onboardingWaba)

// WABA Account Management
WabaRoute.post('/', WabaController.createWaba);
WabaRoute.get('/', WabaController.getWabas);

// Phone Number Management
WabaRoute.post('/:wabaId/phone-numbers', ownedResource('waba_accounts', 'wabaId'), WabaController.addPhoneNumber);
WabaRoute.get('/phone-numbers', WabaController.getPhoneNumbers);
WabaRoute.get('/:wabaId/phone-numbers', ownedResource('waba_accounts', 'wabaId'), WabaController.getWabaPhoneNumbers);

WabaRoute.post('/:wabaId/sync-phone-numbers', ownedResource('waba_accounts', 'wabaId'), WabaController.syncPhoneNumbers);
WabaRoute.put('/phone-numbers/:id', ownedResource('phone_numbers', 'id'), WabaController.updatePhoneNumber);
WabaRoute.delete('/:wabaId/waba-account', ownedResource('waba_accounts', 'wabaId'),WabaController.deleteWabaAccount)
WabaRoute.delete('/phone-numbers/:id', ownedResource('phone_numbers', 'id'), WabaController.deletePhoneNumber);
WabaRoute.post('/:phoneNumberId/verify-number', ownedPhone,WabaController.verifiedPhoneNumber)


export default WabaRoute;
