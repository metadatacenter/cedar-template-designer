'use strict';

define([
  'angular',
  'angularMocks',
  'cedar/template-editor/service/http-builder.service',
  'cedar/template-editor/service/resource.service'
], function () {

  describe('resourceService permission model:', function () {
    var service;

    beforeEach(module('cedar.templateEditor.service.httpBuilderService'));
    beforeEach(module('cedar.templateEditor.service.resourceService', function ($provide) {
      $provide.value('AuthorizedBackendService', {});
      $provide.value('UISettingsService', {});
      $provide.value('UIUtilService', {});
      $provide.value('DataManipulationService', {});
      $provide.value('CedarUser', {});
      $provide.value('UrlService', {});
      $provide.value('CONST', {resourceType: {}});
    }));

    beforeEach(inject(function (_resourceService_) {
      service = _resourceService_;
    }));

    it('keeps Editor separate from Manager and ownership', function () {
      var editor = {currentUserPermissions: {
        role: 'editor',
        capabilities: ['readResource', 'updateResource', 'deleteResource'],
        availableActions: ['copyFromResource'],
        canEdit: false
      }};
      var destination = {currentUserPermissions: {
        role: 'editor',
        capabilities: ['readResource', 'listFolderContents', 'createInFolder', 'copyIntoFolder', 'moveIntoFolder'],
        availableActions: []
      }};

      expect(service.canView(editor)).toBe(true);
      expect(service.canEdit(editor)).toBe(true);
      expect(service.canCreate(editor)).toBe(false);
      expect(service.canCopy(editor)).toBe(true);
      expect(service.canDelete(editor)).toBe(true);
      expect(service.canMove(editor)).toBe(false);
      expect(service.canManageGrants(editor)).toBe(false);
      expect(service.canTransferOwnership(editor)).toBe(false);
      expect(service.canCreate(destination)).toBe(true);
      expect(service.canCopyInto(destination)).toBe(true);
      expect(service.canCopy(destination)).toBe(false);
    });
  });
});
