import { Router, Request, Response } from 'express'
import { config } from '../config/index.js'

const router = Router()

/**
 * The add-in manifest, generated against this deployment's own base URL.
 *
 * Serving it rather than shipping a static file means the professor downloads a manifest
 * that already points at their instance — no hand-editing of URLs during sideloading,
 * and no stale localhost URLs escaping into a production manifest.
 *
 * XML (not the unified JSON manifest) because the target is PowerPoint desktop on both
 * Windows and Mac, where XML is the format with full support.
 *
 * The GUID is stable: changing it makes Office treat the add-in as a different one and
 * orphans every already-sideloaded copy.
 */
const ADDIN_ID = '5e0f6c2a-9b41-4a7d-8f3e-2c1d7b6a4e90'

function manifestXml(baseUrl: string): string {
  const icon = `${baseUrl}/addin/icon-32.png`
  const icon80 = `${baseUrl}/addin/icon-80.png`

  return `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp
  xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
  xmlns:ov="http://schemas.microsoft.com/office/taskpaneappversionoverrides"
  xsi:type="TaskPaneApp">
  <Id>${ADDIN_ID}</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>Pulse</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="Pulse" />
  <Description DefaultValue="Insert Pulse question QR codes and keep them in sync with your class." />
  <IconUrl DefaultValue="${icon}" />
  <HighResolutionIconUrl DefaultValue="${icon80}" />
  <SupportUrl DefaultValue="${baseUrl}" />
  <AppDomains>
    <AppDomain>${baseUrl}</AppDomain>
  </AppDomains>
  <Hosts>
    <Host Name="Presentation" />
  </Hosts>
  <Requirements>
    <Sets DefaultMinVersion="1.1">
      <Set Name="PowerPointApi" MinVersion="1.3" />
    </Sets>
  </Requirements>
  <DefaultSettings>
    <SourceLocation DefaultValue="${baseUrl}/addin/taskpane.html" />
  </DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Hosts>
      <Host xsi:type="Presentation">
        <DesktopFormFactor>
          <GetStarted>
            <Title resid="GetStarted.Title" />
            <Description resid="GetStarted.Description" />
            <LearnMoreUrl resid="GetStarted.LearnMoreUrl" />
          </GetStarted>
          <ExtensionPoint xsi:type="PrimaryCommandSurface">
            <OfficeTab id="TabHome">
              <Group id="Pulse.Group">
                <Label resid="Pulse.GroupLabel" />
                <Icon>
                  <bt:Image size="16" resid="Pulse.Icon16" />
                  <bt:Image size="32" resid="Pulse.Icon32" />
                  <bt:Image size="80" resid="Pulse.Icon80" />
                </Icon>
                <Control xsi:type="Button" id="Pulse.TaskpaneButton">
                  <Label resid="Pulse.ButtonLabel" />
                  <Supertip>
                    <Title resid="Pulse.ButtonLabel" />
                    <Description resid="Pulse.ButtonTooltip" />
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="Pulse.Icon16" />
                    <bt:Image size="32" resid="Pulse.Icon32" />
                    <bt:Image size="80" resid="Pulse.Icon80" />
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <TaskpaneId>ButtonId1</TaskpaneId>
                    <SourceLocation resid="Pulse.Taskpane.Url" />
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
      <bt:Images>
        <bt:Image id="Pulse.Icon16" DefaultValue="${icon}" />
        <bt:Image id="Pulse.Icon32" DefaultValue="${icon}" />
        <bt:Image id="Pulse.Icon80" DefaultValue="${icon80}" />
      </bt:Images>
      <bt:Urls>
        <bt:Url id="Pulse.Taskpane.Url" DefaultValue="${baseUrl}/addin/taskpane.html" />
        <bt:Url id="GetStarted.LearnMoreUrl" DefaultValue="${baseUrl}" />
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="Pulse.GroupLabel" DefaultValue="Pulse" />
        <bt:String id="Pulse.ButtonLabel" DefaultValue="Pulse Questions" />
        <bt:String id="GetStarted.Title" DefaultValue="Pulse is ready." />
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="Pulse.ButtonTooltip" DefaultValue="Insert question QR codes and check this deck against your class." />
        <bt:String id="GetStarted.Description" DefaultValue="Open the Pulse pane from the Home tab to insert question codes and check your deck." />
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>
`
}

router.get('/manifest.xml', (_req: Request, res: Response) => {
  // Office requires HTTPS for add-in content, so a localhost BASE_URL yields a manifest
  // that only works in a dev-cert setup. Trailing slash trimmed to keep URLs well-formed.
  const baseUrl = config.baseUrl.replace(/\/$/, '')
  res.type('application/xml')
  res.setHeader('Content-Disposition', 'attachment; filename="pulse-manifest.xml"')
  res.send(manifestXml(baseUrl))
})

export default router
