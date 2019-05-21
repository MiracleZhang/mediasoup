const h264 = require('h264-profile-level-id');
const utils = require('./utils');
const { UnsupportedError } = require('./errors');
const supportedRtpCapabilities = require('./supportedRtpCapabilities');
const Logger = require('./Logger');

const logger = new Logger('LPZ mediasoup Ortc');

const DynamicPayloadTypes =
[
	100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110,
	111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121,
	122, 123, 124, 125, 126, 127, 96, 97, 98, 99
];

const ScalabilityModeRegex = new RegExp('^L(\\d+)T(\\d+)');

/**
 * Generate RTP capabilities for the Router based on the given media codecs and
 * mediasoup supported RTP capabilities.
 *
 * @param {array<RTCRtpCodecCapability>} mediaCodecs
 *
 * @returns {RTCRtpCapabilities}
 * @throws {UnsupportedError} if codec not supported.
 * @throws {Error}
 */
exports.generateRouterRtpCapabilities = function(mediaCodecs)
{
	logger.debug('generateRouterRtpCapabilities | [mediaCodecs:%o]', mediaCodecs);

	if (!Array.isArray(mediaCodecs))
		throw new TypeError('mediaCodecs must be an Array');
	else if (mediaCodecs.length === 0)
		throw new TypeError('mediaCodecs cannot be empty');

	const dynamicPayloadTypes = utils.clone(DynamicPayloadTypes);
	const supportedCodecs = supportedRtpCapabilities.codecs;

	logger.debug('generateRouterRtpCapabilities | [dynamicPayloadTypes:%o]', dynamicPayloadTypes);
	logger.debug('generateRouterRtpCapabilities | [supportedRtpCapabilities:%o]', supportedRtpCapabilities);
	logger.debug('generateRouterRtpCapabilities | [supportedCodecs:%o]', supportedCodecs);

	const caps =
	{
		codecs           : [],
		headerExtensions : supportedRtpCapabilities.headerExtensions,
		fecMechanisms    : supportedRtpCapabilities.fecMechanisms
	};

	logger.debug('generateRouterRtpCapabilities | [caps:%o]', caps);

	let index = 0;
	for (const mediaCodec of mediaCodecs)
	{
		assertCodecCapability(mediaCodec);

		const matchedSupportedCodec = supportedCodecs
			.find((supportedCodec) => (
				matchCodecs(mediaCodec, supportedCodec, { strict: false }))
			);

		logger.debug('generateRouterRtpCapabilities | [%d] [mediaCodec:%o]', index, mediaCodec);

		if (!matchedSupportedCodec)
		{
			throw new UnsupportedError(
				`media codec not supported [mimeType:${mediaCodec.mimeType}]`);
		}

		// Clone the supported codec.
		const codec = utils.clone(matchedSupportedCodec);
		logger.debug('generateRouterRtpCapabilities | [%d] [codec:%o] 1', index, codec);

		// If the given media codec has preferredPayloadType, keep it.
		if (typeof mediaCodec.preferredPayloadType === 'number')
		{
			codec.preferredPayloadType = mediaCodec.preferredPayloadType;

			// Also remove the pt from the list of available dynamic values.
			const idx = dynamicPayloadTypes.indexOf(codec.preferredPayloadType);

			logger.debug('generateRouterRtpCapabilities | [%d] [codec.preferredPayloadType:%o]', index, codec.preferredPayloadType);
			logger.debug('generateRouterRtpCapabilities | [%d] [idx:%o]', index, idx);

			if (idx > -1)
			{
				logger.debug('generateRouterRtpCapabilities | [%d] idx > -1', index);
				dynamicPayloadTypes.splice(idx, 1);
			}
		}
		// Otherwise if the supported codec has preferredPayloadType, use it.
		else if (typeof codec.preferredPayloadType === 'number')
		{
			logger.debug('generateRouterRtpCapabilities | [%d] codec.preferredPayloadType === number', index);
			// No need to remove it from the list since it's not a dynamic value.
		}
		// Otherwise choose a dynamic one.
		else
		{
			// Take the first available pt and remove it from the list.
			const pt = dynamicPayloadTypes.shift();

			if (!pt)
				throw new Error('cannot allocate more dynamic codec payload types');

			codec.preferredPayloadType = pt;
			logger.debug('generateRouterRtpCapabilities | [%d] [pt:%o]', index, pt);
		}

		// Ensure there is not duplicated preferredPayloadType values.
		if (caps.codecs.some((c) => c.preferredPayloadType === codec.preferredPayloadType))
			throw new Error('duplicated codec.preferredPayloadType');

		// Normalize channels.
		if (codec.kind !== 'audio')
			delete codec.channels;
		else if (!codec.channels)
			codec.channels = 1;

		// Merge the media codec parameters.
		codec.parameters = { ...codec.parameters, ...mediaCodec.parameters };

		// Make rtcpFeedback an array.
		codec.rtcpFeedback = codec.rtcpFeedback || [];

		logger.debug('generateRouterRtpCapabilities | [%d] [codec:%o] 2', index, codec);
		// Append to the codec list.
		caps.codecs.push(codec);

		// Add a RTX video codec if video.
		if (codec.kind === 'video')
		{
			// Take the first available pt and remove it from the list.
			const pt = dynamicPayloadTypes.shift();

			if (!pt)
				throw new Error('cannot allocate more dynamic codec payload types');

			const rtxCodec =
			{
				kind                 : codec.kind,
				mimeType             : `${codec.kind}/rtx`,
				preferredPayloadType : pt,
				clockRate            : codec.clockRate,
				rtcpFeedback         : [],
				parameters           :
				{
					apt : codec.preferredPayloadType
				}
			};

			logger.debug('generateRouterRtpCapabilities | [%d] video [codec:%o]', index, codec);
			// Append to the codec list.
			caps.codecs.push(rtxCodec);
		}
		index++;
	}

	logger.debug('generateRouterRtpCapabilities | return [caps:%o]', caps);
	return caps;
};

/**
 * Get a mapping of the codec payload, RTP header extensions and encodings from
 * the given Producer RTP parameters to the values expected by the Router.
 *
 * It may throw if invalid or non supported RTP parameters are given.
 *
 * @param {RTCRtpParameters} params
 * @param {RTCRtpCapabilities} caps
 *
 * @returns {Object} with codecs, headerExtensions and encodings arrays of objects.
 *   Each codec has payloadType and mappedPayloadType.
 *   Each encoding may have rid and/or ssrc, scalabilityMode and mandatory mappedSsrc.
 * @throws {TypeError} if wrong arguments.
 * @throws {UnsupportedError} if codec not supported.
 * @throws {Error}
 */
exports.getProducerRtpParametersMapping = function(params, caps)
{
	logger.debug('getProducerRtpParametersMapping | [params:%o, caps:%o]', params, caps);
	const rtpMapping =
	{
		codecs    : [],
		encodings : []
	};

	// Match parameters media codecs to capabilities media codecs.
	const codecToCapCodec = new Map();

	let index = 0;
	for (const codec of params.codecs || [])
	{
		assertCodecParameters(codec);

		if (/.+\/rtx$/i.test(codec.mimeType))
		{
			index++;
			continue;
		}

		// Search for the same media codec in capabilities.
		const matchedCapCodec = caps.codecs
			.find((capCodec) => (
				matchCodecs(codec, capCodec, { strict: true, modify: true }))
			);

		if (!matchedCapCodec)
		{
			throw new UnsupportedError(
				`unsupported codec [mimeType:${codec.mimeType}, payloadType:${codec.payloadType}]`);
		}

		logger.debug('getProducerRtpParametersMapping | [%d] [codec:%o, matchedCapCodec:%o]', index, codec, matchedCapCodec);
		codecToCapCodec.set(codec, matchedCapCodec);
		index++;
	}

	index = 0;
	// Match parameters RTX codecs to capabilities RTX codecs.
	for (const codec of params.codecs || [])
	{
		if (!/.+\/rtx$/i.test(codec.mimeType))
		{
			index++;
			continue;
		}
		else if (typeof codec.parameters !== 'object')
			throw TypeError('missing parameters in RTX codec');

		// Search for the associated media codec.
		const associatedMediaCodec = params.codecs
			.find((mediaCodec) => mediaCodec.payloadType === codec.parameters.apt);

		if (!associatedMediaCodec)
		{
			throw new TypeError(
				`missing media codec found for RTX PT ${codec.payloadType}`);
		}

		const capMediaCodec = codecToCapCodec.get(associatedMediaCodec);

		// Ensure that the capabilities media codec has a RTX codec.
		const associatedCapRtxCodec = caps.codecs
			.find((capCodec) => (
				/.+\/rtx$/i.test(capCodec.mimeType) &&
				capCodec.parameters.apt === capMediaCodec.preferredPayloadType
			));

		if (!associatedCapRtxCodec)
		{
			throw new UnsupportedError(
				`no RTX codec for capability codec PT ${capMediaCodec.preferredPayloadType}`);
		}

		logger.debug('getProducerRtpParametersMapping | [%d] [codec:%o, associatedCapRtxCodec:%o, capMediaCodec:%o]', index, codec, associatedCapRtxCodec, capMediaCodec);
		codecToCapCodec.set(codec, associatedCapRtxCodec);
		index++;
	}

	// Generate codecs mapping.
	for (const [ codec, capCodec ] of codecToCapCodec)
	{
		rtpMapping.codecs.push(
			{
				payloadType       : codec.payloadType,
				mappedPayloadType : capCodec.preferredPayloadType
			});
	}

	// Generate encodings mapping.
	let mappedSsrc = utils.generateRandomNumber();
	logger.debug('getProducerRtpParametersMapping | [mappedSsrc:%o]', mappedSsrc);

	for (const encoding of (params.encodings || []))
	{
		const mappedEncoding = {};

		mappedEncoding.mappedSsrc = mappedSsrc++;

		if (encoding.rid)
			mappedEncoding.rid = encoding.rid;
		if (encoding.ssrc)
			mappedEncoding.ssrc = encoding.ssrc;
		if (encoding.scalabilityMode)
			mappedEncoding.scalabilityMode = encoding.scalabilityMode;

		rtpMapping.encodings.push(mappedEncoding);
	}

	logger.debug('getProducerRtpParametersMapping | return [rtpMapping:%o]', rtpMapping);
	return rtpMapping;
};

/**
 * Generate RTP parameters to be internally used by Consumers given the RTP
 * parameters of a Producer and the RTP capabilities of the Router.
 *
 * @param {String} kind
 * @param {RTCRtpParameters} params - RTP parameters of the Producer.
 * @param {RTCRtpCapabilities} caps - RTP capabilities of the Router.
 * @param {Object} rtpMapping - As generated by getProducerRtpParametersMapping().
 *
 * @returns {RTCRtpParameters}
 * @throws {TypeError} if invalid or non supported RTP parameters are given.
 */
exports.getConsumableRtpParameters = function(kind, params, caps, rtpMapping)
{
	logger.debug('getConsumableRtpParameters | [kind:%o, params:%o, caps:%o, rtpMapping:%o]', kind, params, caps, rtpMapping);

	const consumableParams =
	{
		codecs           : [],
		headerExtensions : [],
		encodings        : [],
		rtcp             : {}
	};

	let index = 0;
	for (const codec of params.codecs || [])
	{
		assertCodecParameters(codec);

		if (/.+\/rtx$/i.test(codec.mimeType))
		{
			index++;
			continue;
		}

		const consumableCodecPt = rtpMapping.codecs
			.find((entry) => entry.payloadType === codec.payloadType)
			.mappedPayloadType;

		const matchedCapCodec = caps.codecs
			.find((capCodec) => capCodec.preferredPayloadType === consumableCodecPt);

		const consumableCodec =
		{
			mimeType     : matchedCapCodec.mimeType,
			clockRate    : matchedCapCodec.clockRate,
			payloadType  : matchedCapCodec.preferredPayloadType,
			channels     : matchedCapCodec.channels,
			rtcpFeedback : matchedCapCodec.rtcpFeedback,
			parameters   : codec.parameters // Keep the Producer parameters.
		};

		logger.debug('getConsumableRtpParameters | [%d] [consumableCodecPt:%o, matchedCapCodec:%o, consumableCodec:%o]',
			index, consumableCodecPt, matchedCapCodec, consumableCodec);

		if (!consumableCodec.channels)
			delete consumableCodec.channels;

		consumableParams.codecs.push(consumableCodec);

		const consumableCapRtxCodec = caps.codecs
			.find((capRtxCodec) => (
				/.+\/rtx$/i.test(capRtxCodec.mimeType) &&
				capRtxCodec.parameters.apt === consumableCodec.payloadType
			));

		if (consumableCapRtxCodec)
		{
			const consumableRtxCodec =
			{
				mimeType     : consumableCapRtxCodec.mimeType,
				clockRate    : consumableCapRtxCodec.clockRate,
				payloadType  : consumableCapRtxCodec.preferredPayloadType,
				channels     : consumableCapRtxCodec.channels,
				rtcpFeedback : consumableCapRtxCodec.rtcpFeedback,
				parameters   : consumableCapRtxCodec.parameters
			};

			if (!consumableRtxCodec.channels)
				delete consumableRtxCodec.channels;

			logger.debug('getConsumableRtpParameters | [%d] [consumableCapRtxCodec:%o, consumableRtxCodec:%o]',
				index, consumableCapRtxCodec, consumableRtxCodec);

			consumableParams.codecs.push(consumableRtxCodec);
		}
		index++;
	}

	index = 0;
	for (const capExt of caps.headerExtensions)
	{

		// Just take RTP header extension that can be used in Consumers.
		if (
			capExt.kind !== kind ||
			(capExt.direction !== 'sendrecv' && capExt.direction !== 'sendonly')
		)
		{
			index++;
			continue;
		}

		const consumableExt =
		{
			uri : capExt.uri,
			id  : capExt.preferredId
		};

		logger.debug('getConsumableRtpParameters | [%d] [consumableExt:%o]', index, consumableExt);
		consumableParams.headerExtensions.push(consumableExt);
		index++;
	}

	// Clone Producer encodings since we'll mangle them.
	const consumableEncodings = utils.clone(params.encodings);
	logger.debug('getConsumableRtpParameters | [%d] [consumableEncodings:%o]', index, consumableEncodings);

	for (let i = 0; i < consumableEncodings.length; ++i)
	{
		const consumableEncoding = consumableEncodings[i];
		const { mappedSsrc } = rtpMapping.encodings[i];

		// Remove useless fields.
		delete consumableEncoding.rid;
		delete consumableEncoding.rtx;
		delete consumableEncoding.codecPayloadType;

		// Set the mapped ssrc.
		consumableEncoding.ssrc = mappedSsrc;

		consumableParams.encodings.push(consumableEncoding);
	}

	consumableParams.rtcp =
	{
		cname       : params.rtcp.cname,
		reducedSize : true,
		mux         : true
	};

	logger.debug('getConsumableRtpParameters | [consumableParams:%o]', consumableParams);
	return consumableParams;
};

/**
 * Check whether the given RTP capabilities can consume the given Producer.
 *
 * @param {RTCRtpParameters} consumableParams - Consumable RTP parameters.
 * @param {RTCRtpCapabilities} caps - Remote RTP capabilities.
 *
 * @returns {RTCRtpParameters}
 * @throws {TypeError} if wrong arguments.
 */
exports.canConsume = function(consumableParams, caps)
{
	logger.debug('canConsume | [consumableParams:%o, caps:%o]', consumableParams, caps);
	const matchingCodecs = [];

	for (const capCodec of caps.codecs || [])
	{
		assertCodecCapability(capCodec);
	}

	for (const codec of consumableParams.codecs)
	{
		const matchedCapCodec = caps.codecs
			.find((capCodec) => matchCodecs(capCodec, codec, { strict: true }));

		if (!matchedCapCodec)
			continue;

		matchingCodecs.push(codec);
	}

	// Ensure there is at least one media codec.
	if (
		matchingCodecs.length === 0 ||
		/.+\/rtx$/i.test(matchingCodecs[0].mimeType)
	)
	{
		return false;
	}

	return true;
};

/**
 * Generate RTP parameters for a specific Consumer.
 *
 * It reduces encodings to just one and takes into account given RTP capabilities
 * to reduce codecs, codecs' RTCP feedback and header extensions, and also enables
 * or disabled RTX.
 *
 * @param {RTCRtpParameters} consumableParams - Consumable RTP parameters.
 * @param {RTCRtpCapabilities} caps - Remote RTP capabilities.
 *
 * @returns {RTCRtpParameters}
 * @throws {TypeError} if wrong arguments.
 * @throws {UnsupportedError} if codecs are not compatible.
 */
exports.getConsumerRtpParameters = function(consumableParams, caps)
{
	logger.debug('getConsumerRtpParameters | [consumableParams:%o, caps:%o]', consumableParams, caps);
	const consumerParams =
	{
		codecs           : [],
		headerExtensions : [],
		encodings        : [],
		rtcp             : consumableParams.rtcp
	};

	for (const capCodec of caps.codecs || [])
	{
		assertCodecCapability(capCodec);
	}

	const consumableCodecs = utils.clone(consumableParams.codecs || []);
	let rtxSupported = false;

	for (const codec of consumableCodecs)
	{
		const matchedCapCodec = caps.codecs
			.find((capCodec) => matchCodecs(capCodec, codec, { strict: true }));

		if (!matchedCapCodec)
			continue;

		codec.rtcpFeedback = matchedCapCodec.rtcpFeedback || [];

		consumerParams.codecs.push(codec);

		if (!rtxSupported && /.+\/rtx$/i.test(codec.mimeType))
			rtxSupported = true;
	}

	// Ensure there is at least one media codec.
	if (
		consumerParams.codecs.length === 0 ||
		/.+\/rtx$/i.test(consumerParams.codecs[0].mimeType)
	)
	{
		throw new UnsupportedError('no compatible media codecs');
	}

	consumerParams.headerExtensions = consumableParams.headerExtensions
		.filter((ext) => (
			(caps.headerExtensions || [])
				.some((capExt) => capExt.preferredId === ext.id)
		));

	// Reduce codecs' RTCP feedback. Use Transport-CC if available, REMB otherwise.
	if (
		consumerParams.headerExtensions.some((ext) => (
			ext.uri === 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'
		))
	)
	{
		for (const codec of consumerParams.codecs)
		{
			codec.rtcpFeedback = (codec.rtcpFeedback || [])
				.filter((fb) => fb.type !== 'goog-remb');
		}
	}
	else if (
		consumerParams.headerExtensions.some((ext) => (
			ext.uri === 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time'
		))
	)
	{
		for (const codec of consumerParams.codecs)
		{
			codec.rtcpFeedback = (codec.rtcpFeedback || [])
				.filter((fb) => fb.type !== 'transport-cc');
		}
	}
	else
	{
		for (const codec of consumerParams.codecs)
		{
			codec.rtcpFeedback = (codec.rtcpFeedback || [])
				.filter((fb) => (
					fb.type !== 'transport-cc' &&
					fb.type !== 'goog-remb'
				));
		}
	}

	const consumerEncoding =
	{
		ssrc : utils.generateRandomNumber()
	};

	if (rtxSupported)
		consumerEncoding.rtx = { ssrc: utils.generateRandomNumber() };

	// If any of the consumableParams.encodings has scalabilityMode, process it
	// (assume all encodings have the same value).
	const encodingWithScalabilityMode =
		consumableParams.encodings.find((encoding) => encoding.scalabilityMode);

	let scalabilityMode = encodingWithScalabilityMode
		? encodingWithScalabilityMode.scalabilityMode
		: undefined;

	// If there is simulast, mangle spatial layers in scalabilityMode.
	if (consumableParams.encodings.length > 1)
	{
		const match = ScalabilityModeRegex.exec(scalabilityMode);

		if (match)
			scalabilityMode = `L${consumableParams.encodings.length}T${match[2]}`;
		else
			scalabilityMode = `L${consumableParams.encodings.length}T1`;
	}

	if (scalabilityMode)
		consumerEncoding.scalabilityMode = scalabilityMode;

	// Set a single encoding for the Consumer.
	consumerParams.encodings.push(consumerEncoding);

	// Copy verbatim.
	consumerParams.rtcp = consumableParams.rtcp;

	logger.debug('getConsumerRtpParameters | return [consumerParams:%o]', consumerParams);

	return consumerParams;
};

/**
 * Generate RTP parameters for a pipe Consumer.
 *
 * It keeps all original consumable encodings, removes RTX support and also
 * other features such as NACK.
 *
 * @param {RTCRtpParameters} consumableParams - Consumable RTP parameters.
 *
 * @returns {RTCRtpParameters}
 * @throws {TypeError} if wrong arguments.
 */
exports.getPipeConsumerRtpParameters = function(consumableParams)
{
	logger.debug('getPipeConsumerRtpParameters | [consumableParams:%o]', consumableParams);
	const consumerParams =
	{
		codecs           : [],
		headerExtensions : [],
		encodings        : [],
		rtcp             : consumableParams.rtcp
	};

	const consumableCodecs = utils.clone(consumableParams.codecs || []);

	for (const codec of consumableCodecs)
	{
		if (/.+\/rtx$/i.test(codec.mimeType))
			continue;

		// Reduce RTCP feedbacks by removing NACK support and other features.
		codec.rtcpFeedback = codec.rtcpFeedback
			.filter((fb) => (
				(fb.type === 'nack' && fb.parameter === 'pli') ||
				(fb.type === 'ccm' && fb.parameter === 'fir')
			));

		consumerParams.codecs.push(codec);
	}

	// Reduce RTP extensions by disabling transport BWE related ones.
	consumerParams.headerExtensions = consumableParams.headerExtensions
		.filter((ext) => (
			ext.uri !== 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time' &&
			ext.uri !== 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'
		));

	const consumableEncodings = utils.clone(consumableParams.encodings || []);

	for (const encoding of consumableEncodings)
	{
		delete encoding.rtx;

		consumerParams.encodings.push(encoding);
	}

	logger.debug('getPipeConsumerRtpParameters | [consumerParams:%o]', consumerParams);
	return consumerParams;
};

function assertCodecCapability(codec)
{
	const valid =
		(typeof codec === 'object' && !Array.isArray(codec)) &&
		(typeof codec.mimeType === 'string' && codec.mimeType) &&
		(typeof codec.clockRate === 'number' && codec.clockRate);

	if (!valid)
		throw new TypeError('invalid RTCRtpCodecCapability');

	// Add kind if not present.
	if (!codec.kind)
		codec.kind = codec.mimeType.replace(/\/.*/, '').toLowerCase();
}

function assertCodecParameters(codec)
{
	const valid =
		(typeof codec === 'object' && !Array.isArray(codec)) &&
		(typeof codec.mimeType === 'string' && codec.mimeType) &&
		(typeof codec.clockRate === 'number' && codec.clockRate);

	if (!valid)
		throw new TypeError('invalid RTCRtpCodecParameters');
}

function matchCodecs(aCodec, bCodec, { strict = false, modify = false } = {})
{
	logger.debug('matchCodecs | [aCodec:%o, bCodec:%o, strict:%o, modify:%o]', aCodec, bCodec, strict, modify);

	const aMimeType = aCodec.mimeType.toLowerCase();
	const bMimeType = bCodec.mimeType.toLowerCase();

	if (aMimeType !== bMimeType)
		return false;

	if (aCodec.clockRate !== bCodec.clockRate)
		return false;

	if (
		/^audio\/.+$/i.test(aMimeType) &&
		(
			(aCodec.channels !== undefined && aCodec.channels !== 1) ||
			(bCodec.channels !== undefined && bCodec.channels !== 1)
		) &&
		aCodec.channels !== bCodec.channels
	)
	{
		return false;
	}

	// Per codec special checks.
	switch (aMimeType)
	{
		case 'video/h264':
		{
			const aPacketizationMode = (aCodec.parameters || {})['packetization-mode'] || 0;
			const bPacketizationMode = (bCodec.parameters || {})['packetization-mode'] || 0;

			logger.debug('matchCodecs | [aPacketizationMode:%o, bPacketizationMode:%o]', aPacketizationMode, bPacketizationMode);
			if (aPacketizationMode !== bPacketizationMode)
				return false;

			// If strict matching check profile-level-id.
			if (strict)
			{
				if (!h264.isSameProfile(aCodec.parameters, bCodec.parameters))
					return false;

				let selectedProfileLevelId;

				try
				{
					selectedProfileLevelId =
						h264.generateProfileLevelIdForAnswer(aCodec.parameters, bCodec.parameters);
					logger.debug('matchCodecs | [selectedProfileLevelId:%o]', selectedProfileLevelId);
				}
				catch (error)
				{
					return false;
				}

				if (modify)
				{
					aCodec.parameters = aCodec.parameters || {};

					if (selectedProfileLevelId)
						aCodec.parameters['profile-level-id'] = selectedProfileLevelId;
					else
						delete aCodec.parameters['profile-level-id'];

					logger.debug('matchCodecs | [aCodec.parameters:%o]', aCodec.parameters);
				}
			}

			break;
		}
	}

	return true;
}
