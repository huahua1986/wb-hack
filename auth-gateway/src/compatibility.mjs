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
