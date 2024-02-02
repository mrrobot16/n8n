import { Service } from 'typedi';
import { validate as jsonSchemaValidate } from 'jsonschema';
import type {
	IWorkflowBase,
	ExecutionError,
	INode,
	IRunExecutionData,
	WorkflowExecuteMode,
} from 'n8n-workflow';
import { ApplicationError, Workflow, WorkflowOperationError } from 'n8n-workflow';
import { ActiveExecutions } from '@/ActiveExecutions';
import type {
	ExecutionPayload,
	IExecutionFlattedResponse,
	IExecutionResponse,
	IWorkflowDb,
	IWorkflowExecutionDataProcess,
} from '@/Interfaces';
import { NodeTypes } from '@/NodeTypes';
import { Queue } from '@/Queue';
import type { ExecutionRequest, ExecutionSummaries } from './execution.types';
import { WorkflowRunner } from '@/WorkflowRunner';
import { getStatusUsingPreviousExecutionStatusMethod } from './executionHelpers';
import type { IGetExecutionsQueryFilter } from '@db/repositories/execution.repository';
import { ExecutionRepository } from '@db/repositories/execution.repository';
import { WorkflowRepository } from '@db/repositories/workflow.repository';
import { Logger } from '@/Logger';
import { InternalServerError } from '@/errors/response-errors/internal-server.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import config from '@/config';
import { WaitTracker } from '@/WaitTracker';
import type { ExecutionEntity } from '@/databases/entities/ExecutionEntity';

export const schemaGetExecutionsQueryFilter = {
	$id: '/IGetExecutionsQueryFilter',
	type: 'object',
	properties: {
		id: { type: 'string' },
		finished: { type: 'boolean' },
		mode: { type: 'string' },
		retryOf: { type: 'string' },
		retrySuccessId: { type: 'string' },
		status: {
			type: 'array',
			items: { type: 'string' },
		},
		waitTill: { type: 'boolean' },
		workflowId: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
		metadata: { type: 'array', items: { $ref: '#/$defs/metadata' } },
		startedAfter: { type: 'date-time' },
		startedBefore: { type: 'date-time' },
	},
	$defs: {
		metadata: {
			type: 'object',
			required: ['key', 'value'],
			properties: {
				key: {
					type: 'string',
				},
				value: { type: 'string' },
			},
		},
	},
};

export const allowedExecutionsQueryFilterFields = Object.keys(
	schemaGetExecutionsQueryFilter.properties,
);

@Service()
export class ExecutionService {
	constructor(
		private readonly logger: Logger,
		private readonly queue: Queue,
		private readonly activeExecutions: ActiveExecutions,
		private readonly executionRepository: ExecutionRepository,
		private readonly workflowRepository: WorkflowRepository,
		private readonly nodeTypes: NodeTypes,
		private readonly waitTracker: WaitTracker,
	) {}

	async findOne(
		req: ExecutionRequest.GetOne,
		sharedWorkflowIds: string[],
	): Promise<IExecutionResponse | IExecutionFlattedResponse | undefined> {
		if (!sharedWorkflowIds.length) return undefined;

		const { id: executionId } = req.params;
		const execution = await this.executionRepository.findIfShared(executionId, sharedWorkflowIds);

		if (!execution) {
			this.logger.info('Attempt to read execution was blocked due to insufficient permissions', {
				userId: req.user.id,
				executionId,
			});
			return undefined;
		}

		if (!execution.status) {
			execution.status = getStatusUsingPreviousExecutionStatusMethod(execution);
		}

		return execution;
	}

	async retry(req: ExecutionRequest.Retry, sharedWorkflowIds: string[]) {
		const { id: executionId } = req.params;
		const execution = await this.executionRepository.findWithUnflattenedData(
			executionId,
			sharedWorkflowIds,
		);

		if (!execution) {
			this.logger.info(
				'Attempt to retry an execution was blocked due to insufficient permissions',
				{
					userId: req.user.id,
					executionId,
				},
			);
			throw new NotFoundError(`The execution with the ID "${executionId}" does not exist.`);
		}

		if (execution.finished) {
			throw new ApplicationError('The execution succeeded, so it cannot be retried.');
		}

		const executionMode = 'retry';

		execution.workflowData.active = false;

		// Start the workflow
		const data: IWorkflowExecutionDataProcess = {
			executionMode,
			executionData: execution.data,
			retryOf: req.params.id,
			workflowData: execution.workflowData,
			userId: req.user.id,
		};

		const { lastNodeExecuted } = data.executionData!.resultData;

		if (lastNodeExecuted) {
			// Remove the old error and the data of the last run of the node that it can be replaced
			delete data.executionData!.resultData.error;
			const { length } = data.executionData!.resultData.runData[lastNodeExecuted];
			if (
				length > 0 &&
				data.executionData!.resultData.runData[lastNodeExecuted][length - 1].error !== undefined
			) {
				// Remove results only if it is an error.
				// If we are retrying due to a crash, the information is simply success info from last node
				data.executionData!.resultData.runData[lastNodeExecuted].pop();
				// Stack will determine what to run next
			}
		}

		if (req.body.loadWorkflow) {
			// Loads the currently saved workflow to execute instead of the
			// one saved at the time of the execution.
			const workflowId = execution.workflowData.id;
			const workflowData = (await this.workflowRepository.findOneBy({
				id: workflowId,
			})) as IWorkflowBase;

			if (workflowData === undefined) {
				throw new ApplicationError(
					'Workflow could not be found and so the data not be loaded for the retry.',
					{ extra: { workflowId } },
				);
			}

			data.workflowData = workflowData;

			const workflowInstance = new Workflow({
				id: workflowData.id,
				name: workflowData.name,
				nodes: workflowData.nodes,
				connections: workflowData.connections,
				active: false,
				nodeTypes: this.nodeTypes,
				staticData: undefined,
				settings: workflowData.settings,
			});

			// Replace all of the nodes in the execution stack with the ones of the new workflow
			for (const stack of data.executionData!.executionData!.nodeExecutionStack) {
				// Find the data of the last executed node in the new workflow
				const node = workflowInstance.getNode(stack.node.name);
				if (node === null) {
					this.logger.error('Failed to retry an execution because a node could not be found', {
						userId: req.user.id,
						executionId,
						nodeName: stack.node.name,
					});
					throw new WorkflowOperationError(
						`Could not find the node "${stack.node.name}" in workflow. It probably got deleted or renamed. Without it the workflow can sadly not be retried.`,
					);
				}

				// Replace the node data in the stack that it really uses the current data
				stack.node = node;
			}
		}

		const workflowRunner = new WorkflowRunner();
		const retriedExecutionId = await workflowRunner.run(data);

		const executionData = await this.activeExecutions.getPostExecutePromise(retriedExecutionId);

		if (!executionData) {
			throw new ApplicationError('The retry did not start for an unknown reason.');
		}

		return !!executionData.finished;
	}

	async delete(req: ExecutionRequest.Delete, sharedWorkflowIds: string[]) {
		const { deleteBefore, ids, filters: requestFiltersRaw } = req.body;
		let requestFilters;
		if (requestFiltersRaw) {
			try {
				Object.keys(requestFiltersRaw).map((key) => {
					if (!allowedExecutionsQueryFilterFields.includes(key)) delete requestFiltersRaw[key];
				});
				if (jsonSchemaValidate(requestFiltersRaw, schemaGetExecutionsQueryFilter).valid) {
					requestFilters = requestFiltersRaw as IGetExecutionsQueryFilter;
				}
			} catch (error) {
				throw new InternalServerError('Parameter "filter" contained invalid JSON string.');
			}
		}

		return await this.executionRepository.deleteExecutionsByFilter(
			requestFilters,
			sharedWorkflowIds,
			{
				deleteBefore,
				ids,
			},
		);
	}

	async createErrorExecution(
		error: ExecutionError,
		node: INode,
		workflowData: IWorkflowDb,
		workflow: Workflow,
		mode: WorkflowExecuteMode,
	) {
		const saveDataErrorExecutionDisabled =
			workflowData?.settings?.saveDataErrorExecution === 'none';

		if (saveDataErrorExecutionDisabled) return;

		const executionData: IRunExecutionData = {
			startData: {
				destinationNode: node.name,
				runNodeFilter: [node.name],
			},
			executionData: {
				contextData: {},
				metadata: {},
				nodeExecutionStack: [
					{
						node,
						data: {
							main: [
								[
									{
										json: {},
										pairedItem: {
											item: 0,
										},
									},
								],
							],
						},
						source: null,
					},
				],
				waitingExecution: {},
				waitingExecutionSource: {},
			},
			resultData: {
				runData: {
					[node.name]: [
						{
							startTime: 0,
							executionTime: 0,
							error,
							source: [],
						},
					],
				},
				error,
				lastNodeExecuted: node.name,
			},
		};

		const fullExecutionData: ExecutionPayload = {
			data: executionData,
			mode,
			finished: false,
			startedAt: new Date(),
			workflowData,
			workflowId: workflow.id,
			stoppedAt: new Date(),
			status: 'error',
		};

		await this.executionRepository.createNewExecution(fullExecutionData);
	}

	// ----------------------------------
	//             new API
	// ----------------------------------

	private readonly isRegularMode = config.getEnv('executions.mode') === 'regular';

	/**
	 * Find the `n` most recent executions with a status of `success` or `error`.
	 */
	async findLatestFinished(n: number) {
		return await this.executionRepository.findLatestFinished(n);
	}

	/**
	 * Find all executions with a status of `new`, `running`, and `waiting`.
	 */
	async findAllActive() {
		return await this.executionRepository.findAllActive();
	}

	/**
	 * Find a range of summaries of executions that satisfy a query, along with the
	 * total count of all existing executions that satisfy the query, and whether
	 * the total is an estimate or not.
	 */
	async findRangeWithCount(query: ExecutionSummaries.RangeQuery) {
		const executions = await this.executionRepository.findManyByRangeQuery(query);

		if (config.getEnv('database.type') === 'postgresdb') {
			const liveRows = await this.executionRepository.getLiveExecutionRowsOnPostgres();

			if (liveRows === -1) return { count: -1, estimated: false, results: executions };

			if (liveRows > 100_000) {
				// likely too high to fetch exact count fast
				return { count: liveRows, estimated: true, results: executions };
			}
		}

		const { range: _, ...countQuery } = query;

		const count = await this.executionRepository.fetchCount({ ...countQuery, kind: 'count' });

		return { count, estimated: false, results: executions };
	}

	/**
	 * Stop an active execution.
	 */
	async stop(executionId: string) {
		const execution = await this.executionRepository.findOneBy({ id: executionId });

		if (!execution) throw new NotFoundError('Execution not found');

		const stopResult = await this.activeExecutions.stopExecution(execution.id);

		if (stopResult) return this.toExecutionStopResult(execution);

		if (this.isRegularMode) {
			return await this.waitTracker.stopExecution(execution.id);
		}

		// queue mode

		try {
			return await this.waitTracker.stopExecution(execution.id);
		} catch {
			// @TODO: Why are we swallowing this error in queue mode?
		}

		const activeJobs = await this.queue.getJobs(['active', 'waiting']);
		const job = activeJobs.find(({ data }) => data.executionId === execution.id);

		if (job) {
			await this.queue.stopJob(job);
		} else {
			this.logger.debug('Job to stop no longer in queue', { jobId: execution.id });
		}

		return this.toExecutionStopResult(execution);
	}

	private toExecutionStopResult(execution: ExecutionEntity) {
		return {
			mode: execution.mode,
			startedAt: new Date(execution.startedAt),
			stoppedAt: execution.stoppedAt ? new Date(execution.stoppedAt) : undefined,
			finished: execution.finished,
			status: execution.status,
		};
	}
}
