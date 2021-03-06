const download = require('download')
const { Cos } = require('tencent-component-toolkit')
const { TypeError } = require('tencent-component-toolkit/src/utils/error')
const CONFIGS = require('./config')

/**
 * Generate random id
 */
const generateId = () =>
  Math.random()
    .toString(36)
    .substring(6)

const getType = (obj) => {
  return Object.prototype.toString.call(obj).slice(8, -1)
}

const validateTraffic = (num) => {
  if (getType(num) !== 'Number') {
    throw new TypeError(
      `PARAMETER_${CONFIGS.compName.toUpperCase()}_TRAFFIC`,
      'traffic must be a number'
    )
  }
  if (num < 0 || num > 1) {
    throw new TypeError(
      `PARAMETER_${CONFIGS.compName.toUpperCase()}_TRAFFIC`,
      'traffic must be a number between 0 and 1'
    )
  }
  return true
}

const getDefaultFunctionName = (instance) => {
  return `${instance.name}-${instance.stage}-${instance.app}`
}

const getDefaultTriggerName = (type, instance) => {
  return `${type}-${instance.name}-${instance.stage}`
}

const getDefaultServiceName = (instance) => {
  return `${instance.name}_${instance.stage}`
}

const getDefaultServiceDescription = (instance) => {
  return `${instance.name}-${instance.stage}-${instance.app}`
}

/**
 * get default template zip file path
 */
const getDefaultZipPath = async () => {
  console.log(`Packaging ${CONFIGS.compFullname} application...`)

  // unzip source zip file
  // add default template
  const downloadPath = `/tmp/${generateId()}`
  const filename = 'template'

  console.log(`Installing Default ${CONFIGS.compFullname} App...`)
  try {
    await download(CONFIGS.templateUrl, downloadPath, {
      filename: `${filename}.zip`
    })
  } catch (e) {
    throw new TypeError(
      `DOWNLOAD_${CONFIGS.compName.toUpperCase()}_TEMPLATE`,
      'Download default template failed.'
    )
  }
  const zipPath = `${downloadPath}/${filename}.zip`

  return zipPath
}

/**
 * prepare scf deploy input parameters
 * @param {Component} instance serverless component
 * @param {object} credentials component credentials
 * @param {string} appId app id
 * @param {object} inputs yml inputs
 */
const prepareInputs = async (instance, credentials, appId, inputs) => {
  // 默认值
  const region = inputs.region || CONFIGS.region
  inputs.srcOriginal = inputs.srcOriginal || inputs.src
  const tempSrc =
    typeof inputs.srcOriginal === 'object'
      ? inputs.srcOriginal
      : typeof inputs.srcOriginal === 'string'
      ? {
          src: inputs.srcOriginal
        }
      : {}

  const code = {
    bucket: tempSrc.bucket || `sls-cloudfunction-${region}-code`,
    object:
      tempSrc.object ||
      `/${CONFIGS.compName}_component_${generateId()}-${Math.floor(Date.now() / 1000)}.zip`
  }
  const cos = new Cos(credentials, region)
  const bucket = `${code.bucket}-${appId}`

  // create new bucket, and setup lifecycle for it
  if (!tempSrc.bucket) {
    await cos.deploy({
      bucket: bucket,
      force: true,
      lifecycle: [
        {
          status: 'Enabled',
          id: 'deleteObject',
          filter: '',
          expiration: { days: '10' },
          abortIncompleteMultipartUpload: { daysAfterInitiation: '10' }
        }
      ]
    })
  }

  let useDefault
  if (!tempSrc.object) {
    // whether use default template, if so, download it
    // get default template code
    let zipPath
    if (!tempSrc.src) {
      useDefault = true
      zipPath = await getDefaultZipPath()
      inputs.src = zipPath
    } else {
      zipPath = inputs.src
    }
    console.log(`Uploading code ${code.object} to bucket ${bucket}`)
    await cos.upload({
      bucket: bucket,
      file: zipPath,
      key: code.object
    })
  }

  const oldState = instance.state
  inputs.name =
    inputs.name ||
    (oldState.function && oldState.function.FunctionName) ||
    getDefaultFunctionName(instance)
  inputs.runtime = inputs.runtime || CONFIGS.runtime
  inputs.handler = inputs.handler || CONFIGS.handler(inputs.runtime)
  inputs.description = inputs.description || CONFIGS.description(instance.app)
  inputs.code = code
  inputs.events = inputs.events || []

  const stateApigw = oldState.apigw
  const triggers = {}
  const apigwName = []

  let existApigwTrigger = false
  // initial apigw event parameters
  inputs.events = inputs.events.map((event) => {
    const eventType = Object.keys(event)[0]
    // check trigger type
    if (CONFIGS.triggerTypes.indexOf(eventType) === -1) {
      throw new TypeError(
        `PARAMETER_${CONFIGS.compName.toUpperCase()}_APIGW_TRIGGER`,
        `Unknow trigger type ${eventType}, must be one of ${JSON.stringify(CONFIGS.triggerTypes)}`
      )
    }
    const currentEvent = event[eventType]
    triggers[eventType] = triggers[eventType] || []

    if (eventType === 'apigw') {
      if (apigwName.includes(currentEvent.name)) {
        throw new TypeError(
          `PARAMETER_${CONFIGS.compName.toUpperCase()}_APIGW_TRIGGER`,
          `API Gateway name must be unique`
        )
      } else {
        currentEvent.parameters.serviceName =
          currentEvent.parameters.serviceName ||
          currentEvent.name ||
          getDefaultServiceName(instance)
        currentEvent.parameters.description =
          currentEvent.parameters.description || getDefaultServiceDescription(instance)
        currentEvent.name = currentEvent.name || getDefaultTriggerName(eventType, instance)
        if (stateApigw && stateApigw[currentEvent.name]) {
          currentEvent.parameters.serviceId =
            currentEvent.parameters.serviceId || stateApigw[currentEvent.name]
        }
        apigwName.push(currentEvent.name)
      }
      existApigwTrigger = true
    } else {
      currentEvent.name = currentEvent.name || getDefaultTriggerName(eventType, instance)
      triggers[eventType].push(currentEvent.name)
    }
    return event
  })

  // if not config apig trigger, and make autoCreateApi true
  if (inputs.autoCreateApi && !existApigwTrigger) {
    triggers.apigw = []
    const { defaultApigw } = CONFIGS
    defaultApigw.parameters.serviceName = getDefaultServiceName(instance)
    defaultApigw.parameters.description = getDefaultServiceDescription(instance)
    inputs.events.push({
      apigw: defaultApigw
    })

    existApigwTrigger = true
  }

  // validate traffic config
  if (inputs.traffic !== undefined) {
    validateTraffic(inputs.traffic)
  }

  inputs.lastVersion = instance.state.lastVersion

  return {
    useDefault,
    existApigwTrigger,
    scfInputs: inputs,
    triggers
  }
}

module.exports = {
  getType,
  generateId,
  prepareInputs,
  getDefaultZipPath
}
