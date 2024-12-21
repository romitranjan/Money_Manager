import { Buffer } from 'buffer/';
import { getDefaultAgent, ReplicaRejectCode, } from './agent';
import { AgentError } from './errors';
import { bufFromBufLike, IDL } from '@dfinity/candid';
import { pollForResponse, strategy } from './polling';
import { Principal } from '@dfinity/principal';
import { toHex } from './utils/buffer';
import { Certificate, lookupResultToBuffer } from './certificate';
import managementCanisterIdl from './canisters/management_idl';
export class ActorCallError extends AgentError {
    constructor(canisterId, methodName, type, props) {
        super([
            `Call failed:`,
            `  Canister: ${canisterId.toText()}`,
            `  Method: ${methodName} (${type})`,
            ...Object.getOwnPropertyNames(props).map(n => `  "${n}": ${JSON.stringify(props[n])}`),
        ].join('\n'));
        this.canisterId = canisterId;
        this.methodName = methodName;
        this.type = type;
        this.props = props;
    }
}
export class QueryCallRejectedError extends ActorCallError {
    constructor(canisterId, methodName, result) {
        var _a;
        super(canisterId, methodName, 'query', {
            Status: result.status,
            Code: (_a = ReplicaRejectCode[result.reject_code]) !== null && _a !== void 0 ? _a : `Unknown Code "${result.reject_code}"`,
            Message: result.reject_message,
        });
        this.result = result;
    }
}
export class UpdateCallRejectedError extends ActorCallError {
    constructor(canisterId, methodName, requestId, response, reject_code, reject_message, error_code) {
        super(canisterId, methodName, 'update', Object.assign({ 'Request ID': toHex(requestId) }, (response.body
            ? Object.assign(Object.assign({}, (error_code
                ? {
                    'Error code': error_code,
                }
                : {})), { 'Reject code': String(reject_code), 'Reject message': reject_message }) : {
            'HTTP status code': response.status.toString(),
            'HTTP status text': response.statusText,
        })));
        this.requestId = requestId;
        this.response = response;
        this.reject_code = reject_code;
        this.reject_message = reject_message;
        this.error_code = error_code;
    }
}
const metadataSymbol = Symbol.for('ic-agent-metadata');
/**
 * An actor base class. An actor is an object containing only functions that will
 * return a promise. These functions are derived from the IDL definition.
 */
export class Actor {
    constructor(metadata) {
        this[metadataSymbol] = Object.freeze(metadata);
    }
    /**
     * Get the Agent class this Actor would call, or undefined if the Actor would use
     * the default agent (global.ic.agent).
     * @param actor The actor to get the agent of.
     */
    static agentOf(actor) {
        return actor[metadataSymbol].config.agent;
    }
    /**
     * Get the interface of an actor, in the form of an instance of a Service.
     * @param actor The actor to get the interface of.
     */
    static interfaceOf(actor) {
        return actor[metadataSymbol].service;
    }
    static canisterIdOf(actor) {
        return Principal.from(actor[metadataSymbol].config.canisterId);
    }
    static async install(fields, config) {
        const mode = fields.mode === undefined ? { install: null } : fields.mode;
        // Need to transform the arg into a number array.
        const arg = fields.arg ? [...new Uint8Array(fields.arg)] : [];
        // Same for module.
        const wasmModule = [...new Uint8Array(fields.module)];
        const canisterId = typeof config.canisterId === 'string'
            ? Principal.fromText(config.canisterId)
            : config.canisterId;
        await getManagementCanister(config).install_code({
            mode,
            arg,
            wasm_module: wasmModule,
            canister_id: canisterId,
            sender_canister_version: [],
        });
    }
    static async createCanister(config, settings) {
        function settingsToCanisterSettings(settings) {
            return [
                {
                    controllers: settings.controllers ? [settings.controllers] : [],
                    compute_allocation: settings.compute_allocation ? [settings.compute_allocation] : [],
                    freezing_threshold: settings.freezing_threshold ? [settings.freezing_threshold] : [],
                    memory_allocation: settings.memory_allocation ? [settings.memory_allocation] : [],
                    reserved_cycles_limit: [],
                    log_visibility: [],
                    wasm_memory_limit: [],
                },
            ];
        }
        const { canister_id: canisterId } = await getManagementCanister(config || {}).provisional_create_canister_with_cycles({
            amount: [],
            settings: settingsToCanisterSettings(settings || {}),
            specified_id: [],
            sender_canister_version: [],
        });
        return canisterId;
    }
    static async createAndInstallCanister(interfaceFactory, fields, config) {
        const canisterId = await this.createCanister(config);
        await this.install(Object.assign({}, fields), Object.assign(Object.assign({}, config), { canisterId }));
        return this.createActor(interfaceFactory, Object.assign(Object.assign({}, config), { canisterId }));
    }
    static createActorClass(interfaceFactory, options) {
        const service = interfaceFactory({ IDL });
        class CanisterActor extends Actor {
            constructor(config) {
                if (!config.canisterId)
                    throw new AgentError(`Canister ID is required, but received ${typeof config.canisterId} instead. If you are using automatically generated declarations, this may be because your application is not setting the canister ID in process.env correctly.`);
                const canisterId = typeof config.canisterId === 'string'
                    ? Principal.fromText(config.canisterId)
                    : config.canisterId;
                super({
                    config: Object.assign(Object.assign(Object.assign({}, DEFAULT_ACTOR_CONFIG), config), { canisterId }),
                    service,
                });
                for (const [methodName, func] of service._fields) {
                    if (options === null || options === void 0 ? void 0 : options.httpDetails) {
                        func.annotations.push(ACTOR_METHOD_WITH_HTTP_DETAILS);
                    }
                    if (options === null || options === void 0 ? void 0 : options.certificate) {
                        func.annotations.push(ACTOR_METHOD_WITH_CERTIFICATE);
                    }
                    this[methodName] = _createActorMethod(this, methodName, func, config.blsVerify);
                }
            }
        }
        return CanisterActor;
    }
    static createActor(interfaceFactory, configuration) {
        if (!configuration.canisterId) {
            throw new AgentError(`Canister ID is required, but received ${typeof configuration.canisterId} instead. If you are using automatically generated declarations, this may be because your application is not setting the canister ID in process.env correctly.`);
        }
        return new (this.createActorClass(interfaceFactory))(configuration);
    }
    /**
     * Returns an actor with methods that return the http response details along with the result
     * @param interfaceFactory - the interface factory for the actor
     * @param configuration - the configuration for the actor
     * @deprecated - use createActor with actorClassOptions instead
     */
    static createActorWithHttpDetails(interfaceFactory, configuration) {
        return new (this.createActorClass(interfaceFactory, { httpDetails: true }))(configuration);
    }
    /**
     * Returns an actor with methods that return the http response details along with the result
     * @param interfaceFactory - the interface factory for the actor
     * @param configuration - the configuration for the actor
     * @param actorClassOptions - options for the actor class extended details to return with the result
     */
    static createActorWithExtendedDetails(interfaceFactory, configuration, actorClassOptions = {
        httpDetails: true,
        certificate: true,
    }) {
        return new (this.createActorClass(interfaceFactory, actorClassOptions))(configuration);
    }
}
// IDL functions can have multiple return values, so decoding always
// produces an array. Ensure that functions with single or zero return
// values behave as expected.
function decodeReturnValue(types, msg) {
    const returnValues = IDL.decode(types, Buffer.from(msg));
    switch (returnValues.length) {
        case 0:
            return undefined;
        case 1:
            return returnValues[0];
        default:
            return returnValues;
    }
}
const DEFAULT_ACTOR_CONFIG = {
    pollingStrategyFactory: strategy.defaultStrategy,
};
export const ACTOR_METHOD_WITH_HTTP_DETAILS = 'http-details';
export const ACTOR_METHOD_WITH_CERTIFICATE = 'certificate';
function _createActorMethod(actor, methodName, func, blsVerify) {
    let caller;
    if (func.annotations.includes('query') || func.annotations.includes('composite_query')) {
        caller = async (options, ...args) => {
            var _a, _b;
            // First, if there's a config transformation, call it.
            options = Object.assign(Object.assign({}, options), (_b = (_a = actor[metadataSymbol].config).queryTransform) === null || _b === void 0 ? void 0 : _b.call(_a, methodName, args, Object.assign(Object.assign({}, actor[metadataSymbol].config), options)));
            const agent = options.agent || actor[metadataSymbol].config.agent || getDefaultAgent();
            const cid = Principal.from(options.canisterId || actor[metadataSymbol].config.canisterId);
            const arg = IDL.encode(func.argTypes, args);
            const result = await agent.query(cid, {
                methodName,
                arg,
                effectiveCanisterId: options.effectiveCanisterId,
            });
            const httpDetails = Object.assign(Object.assign({}, result.httpDetails), { requestDetails: result.requestDetails });
            switch (result.status) {
                case "rejected" /* QueryResponseStatus.Rejected */:
                    throw new QueryCallRejectedError(cid, methodName, result);
                case "replied" /* QueryResponseStatus.Replied */:
                    return func.annotations.includes(ACTOR_METHOD_WITH_HTTP_DETAILS)
                        ? {
                            httpDetails,
                            result: decodeReturnValue(func.retTypes, result.reply.arg),
                        }
                        : decodeReturnValue(func.retTypes, result.reply.arg);
            }
        };
    }
    else {
        caller = async (options, ...args) => {
            var _a, _b;
            // First, if there's a config transformation, call it.
            options = Object.assign(Object.assign({}, options), (_b = (_a = actor[metadataSymbol].config).callTransform) === null || _b === void 0 ? void 0 : _b.call(_a, methodName, args, Object.assign(Object.assign({}, actor[metadataSymbol].config), options)));
            const agent = options.agent || actor[metadataSymbol].config.agent || getDefaultAgent();
            const { canisterId, effectiveCanisterId, pollingStrategyFactory } = Object.assign(Object.assign(Object.assign({}, DEFAULT_ACTOR_CONFIG), actor[metadataSymbol].config), options);
            const cid = Principal.from(canisterId);
            const ecid = effectiveCanisterId !== undefined ? Principal.from(effectiveCanisterId) : cid;
            const arg = IDL.encode(func.argTypes, args);
            if (agent.rootKey == null)
                throw new AgentError('Agent root key not initialized before making call');
            const { requestId, response, requestDetails } = await agent.call(cid, {
                methodName,
                arg,
                effectiveCanisterId: ecid,
            });
            let reply;
            let certificate;
            if (response.body && response.body.certificate) {
                const cert = response.body.certificate;
                certificate = await Certificate.create({
                    certificate: bufFromBufLike(cert),
                    rootKey: agent.rootKey,
                    canisterId: Principal.from(canisterId),
                    blsVerify,
                });
                const path = [new TextEncoder().encode('request_status'), requestId];
                const status = new TextDecoder().decode(lookupResultToBuffer(certificate.lookup([...path, 'status'])));
                switch (status) {
                    case 'replied':
                        reply = lookupResultToBuffer(certificate.lookup([...path, 'reply']));
                        break;
                    case 'rejected': {
                        // Find rejection details in the certificate
                        const rejectCode = new Uint8Array(lookupResultToBuffer(certificate.lookup([...path, 'reject_code'])))[0];
                        const rejectMessage = new TextDecoder().decode(lookupResultToBuffer(certificate.lookup([...path, 'reject_message'])));
                        const error_code_buf = lookupResultToBuffer(certificate.lookup([...path, 'error_code']));
                        const error_code = error_code_buf
                            ? new TextDecoder().decode(error_code_buf)
                            : undefined;
                        throw new UpdateCallRejectedError(cid, methodName, requestId, response, rejectCode, rejectMessage, error_code);
                    }
                }
            }
            else if (response.body && 'reject_message' in response.body) {
                // handle v2 response errors by throwing an UpdateCallRejectedError object
                const { reject_code, reject_message, error_code } = response.body;
                throw new UpdateCallRejectedError(cid, methodName, requestId, response, reject_code, reject_message, error_code);
            }
            // Fall back to polling if we receive an Accepted response code
            if (response.status === 202) {
                const pollStrategy = pollingStrategyFactory();
                // Contains the certificate and the reply from the boundary node
                const response = await pollForResponse(agent, ecid, requestId, pollStrategy, blsVerify);
                certificate = response.certificate;
                reply = response.reply;
            }
            const shouldIncludeHttpDetails = func.annotations.includes(ACTOR_METHOD_WITH_HTTP_DETAILS);
            const shouldIncludeCertificate = func.annotations.includes(ACTOR_METHOD_WITH_CERTIFICATE);
            const httpDetails = Object.assign(Object.assign({}, response), { requestDetails });
            if (reply !== undefined) {
                if (shouldIncludeHttpDetails && shouldIncludeCertificate) {
                    return {
                        httpDetails,
                        certificate,
                        result: decodeReturnValue(func.retTypes, reply),
                    };
                }
                else if (shouldIncludeCertificate) {
                    return {
                        certificate,
                        result: decodeReturnValue(func.retTypes, reply),
                    };
                }
                else if (shouldIncludeHttpDetails) {
                    return {
                        httpDetails,
                        result: decodeReturnValue(func.retTypes, reply),
                    };
                }
                return decodeReturnValue(func.retTypes, reply);
            }
            else if (func.retTypes.length === 0) {
                return shouldIncludeHttpDetails
                    ? {
                        httpDetails: response,
                        result: undefined,
                    }
                    : undefined;
            }
            else {
                throw new Error(`Call was returned undefined, but type [${func.retTypes.join(',')}].`);
            }
        };
    }
    const handler = (...args) => caller({}, ...args);
    handler.withOptions =
        (options) => (...args) => caller(options, ...args);
    return handler;
}
/**
 * Create a management canister actor
 * @param config - a CallConfig
 */
export function getManagementCanister(config) {
    function transform(methodName, args) {
        if (config.effectiveCanisterId) {
            return { effectiveCanisterId: Principal.from(config.effectiveCanisterId) };
        }
        const first = args[0];
        let effectiveCanisterId = Principal.fromHex('');
        if (first && typeof first === 'object' && first.target_canister && methodName === "install_chunked_code") {
            effectiveCanisterId = Principal.from(first.target_canister);
        }
        if (first && typeof first === 'object' && first.canister_id) {
            effectiveCanisterId = Principal.from(first.canister_id);
        }
        return { effectiveCanisterId };
    }
    return Actor.createActor(managementCanisterIdl, Object.assign(Object.assign(Object.assign({}, config), { canisterId: Principal.fromHex('') }), {
        callTransform: transform,
        queryTransform: transform,
    }));
}
export class AdvancedActor extends Actor {
    constructor(metadata) {
        super(metadata);
    }
}
//# sourceMappingURL=actor.js.map