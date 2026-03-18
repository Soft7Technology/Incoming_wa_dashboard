import { Router } from 'express';
import WabaController from '@surefy/console/http/controllers/waba.controller';

const WabaRoute = Router();

// All WABA endpoints require authentication (applied at route group level)

WabaRoute.post('/onboard', WabaController.onboardingWaba)

// WABA Account Management
WabaRoute.post('/', WabaController.createWaba);
WabaRoute.get('/', WabaController.getWabas);

// Phone Number Management
WabaRoute.post('/:wabaId/phone-numbers', WabaController.addPhoneNumber);
WabaRoute.get('/phone-numbers', WabaController.getPhoneNumbers);
WabaRoute.get('/:wabaId/phone-numbers', WabaController.getWabaPhoneNumbers);
WabaRoute.post('/:wabaId/sync-phone-numbers', WabaController.syncPhoneNumbers);
WabaRoute.put('/phone-numbers/:id', WabaController.updatePhoneNumber);
WabaRoute.delete('/phone-numbers/:id', WabaController.deletePhoneNumber);

export default WabaRoute;
