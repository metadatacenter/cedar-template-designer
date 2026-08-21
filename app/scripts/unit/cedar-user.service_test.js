'use strict';

define([
  'angular',
  'angularMocks',
  'cedar/template-editor/service/cedar-user'
], function () {

  describe('CedarUser application data:', function () {
    var CedarUser;
    var $rootScope;

    beforeEach(module('cedar.templateEditor.service.cedarUser'));

    beforeEach(inject(function (_CedarUser_, _$rootScope_) {
      CedarUser = _CedarUser_;
      $rootScope = _$rootScope_;
    }));

    it('initializes its owned profile and navigation state without a legacy global', function () {
      expect(window.AppData).toBeUndefined();

      CedarUser.init();

      expect($rootScope.appData.cedarUserProfile).toBeNull();
      expect($rootScope.appData.authUserProfile).toBeNull();
      expect($rootScope.appData.navigation).toEqual({});
      expect(Object.isExtensible($rootScope.appData)).toBe(false);
    });
  });
});
