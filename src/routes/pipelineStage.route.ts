import { Router } from 'express';
import PipelineStageController from '@surefy/console/http/controllers/pipelineStage.controller';

const PipelineStageRoute = Router();

PipelineStageRoute.get('/', PipelineStageController.getStages);
PipelineStageRoute.post('/', PipelineStageController.createStage);
PipelineStageRoute.get('/:id', PipelineStageController.getStageById);
PipelineStageRoute.put('/:id', PipelineStageController.updateStage);
PipelineStageRoute.delete('/:id', PipelineStageController.deleteStage);

export default PipelineStageRoute;
