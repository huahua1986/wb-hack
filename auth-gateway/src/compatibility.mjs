export const LOCAL_FEATURES = Object.freeze({
  CustomModelsJSON: true,
  CustomModelIdPrefix: true,
  CustomModelHideDefaultProvider: true,
  EnableEnterpriseCustomModelPolicy: false,
  EnableEnterpriseSkillUploadPolicy: false,
  EnableEnterpriseCustomConnectorPolicy: false,
  DisableCreditsEntry: true,
  DisableCreditPurchaseGuide: true,
  TencentNetDriveKnowledge: false,
  DisableCloudAssistantUpgradeBanner: true,
  DisableTeamsProject: true,
  Claw: false,
  UseEnterpriseDownloadSource: true,
  DisableSkillHub: true,
  ConnectorMarketApiEnabled: false,
});

export function localProductOverlay(endpoint) {
  return {
    endpoint,
    networkEnvironment: 'selfhosted',
    config: { disabled: true },
    productFeatureExperiment: { enabled: false, pollingEnabled: false },
    productFeatures: { ...LOCAL_FEATURES },
  };
}

// Compatibility metadata only. No remote model definitions, quota balances,
// model proxying, or Tencent upstream calls are provided by this service.
export function compatibilityConfiguration(productName) {
  return { productFeatures: { ...LOCAL_FEATURES }, config: { disabled: true }, models: [],
    ...(productName ? { productFeatureExperiment: { enabled: true, pollingEnabled: false } } : {}),
  };
}

export const DISABLED_CLOUD_LIST_PATHS = Object.freeze([
  '/v2/user/cloudagent/conversations',
  '/v2/user/cloudagent/agents/enterprise-published',
]);

// These are read-only catalogues for a capability this private backend does not host.
// Match the 5.8.3 consumers' pagination contract; writes and other routes stay unsupported.
export function disabledCloudList(route, query) {
  if (!DISABLED_CLOUD_LIST_PATHS.includes(route)) return undefined;
  const page = Number(query.get('page') ?? 1);
  const pageSize = Number(query.get('pageSize') ?? (route.endsWith('/conversations') ? 1000 : 100));
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw Object.assign(new Error('无效的云目录分页参数'), { status: 400 });
  }
  return { items: [], total: 0, page, pageSize, ...(route.endsWith('/conversations') ? { totalPages: 0, hasNext: false } : {}) };
}
