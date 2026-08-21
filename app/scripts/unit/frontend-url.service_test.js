'use strict';

define([
  'angular',
  'angularMocks',
  'json!config/url-service.conf.json',
  'cedar/template-editor/service/frontend-url.service'
], function (angular, angularMocks, config) {

  describe('FrontendUrlService Workspace return contract:', function () {
    var FrontendUrlService;
    var workspaceBase;

    beforeEach(module('cedar.templateEditor.service.frontendUrlService'));

    beforeEach(inject(function (_FrontendUrlService_) {
      FrontendUrlService = _FrontendUrlService_;
      FrontendUrlService.init();
      workspaceBase = config.workspaceFrontend.replace(/\/$/, '');
    }));

    it('preserves an exact same-origin Workspace return URL', function () {
      var returnTo = workspaceBase + '/dashboard?search=cells&folderId=folder-1#details';

      expect(FrontendUrlService.getWorkspaceReturn(returnTo, 'ignored-folder')).toBe(returnTo);
    });

    it('rejects a lookalike host and falls back to the requested folder', function () {
      var maliciousReturn = workspaceBase + '.example.org/dashboard';

      expect(FrontendUrlService.getWorkspaceReturn(maliciousReturn, 'https://repo.example/folders/1'))
          .toBe(workspaceBase + '/dashboard?folderId=' +
              encodeURIComponent('https://repo.example/folders/1'));
    });

    it('rejects a cross-origin return URL', function () {
      expect(FrontendUrlService.getWorkspaceReturn('https://example.org/phishing'))
          .toBe(workspaceBase + '/dashboard');
    });
  });
});
