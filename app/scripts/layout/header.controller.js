'use strict';

define([
  'angular'
], function (angular) {
  angular.module('cedar.templateEditor.layout.headerController', [])
      .controller('HeaderCtrl', HeaderController);

  HeaderController.$inject = [
    '$rootScope',
    '$location',
    '$window',
    '$timeout',
    '$document',
    '$translate',
    'QueryParamUtilsService',
    'UIMessageService',
    'UIUtilService',
    'FrontendUrlService'
  ];

  function HeaderController($rootScope, $location, $window, $timeout, $document, $translate,
                            QueryParamUtilsService, UIMessageService, UIUtilService, FrontendUrlService) {

    var vm = this;
    vm.path = $location.path();
    vm.allowUnload = false;

    $window.onbeforeunload = function () {
      if (vm.isDirty() && !vm.allowUnload) {
        return 'You have some unsaved changes';
      }
    };

    vm.isDirty = function () {
      return UIUtilService.isDirty();
    };

    vm.isLocked = function () {
      return UIUtilService.isLocked();
    };

    vm.validTip = function () {
      return $translate.instant('Document is ' + (UIUtilService.isValid() ? 'valid' : 'invalid'));
    };

    vm.validIcon = function () {
      return UIUtilService.isValid() ? 'fa-check' : 'fa-exclamation-triangle';
    };

    vm.dirtyCleanTip = function () {
      return $translate.instant(UIUtilService.isDirty() ? 'Save required' : 'No save required');
    };

    vm.lockUnlockTip = function () {
      return $translate.instant('Document is ' + (UIUtilService.isLocked() ? 'locked' : 'unlocked'));
    };

    vm.confirmBack = function () {
      if (UIUtilService.isLocked() || !UIUtilService.isDirty()) {
        vm.returnToWorkspace();
        return;
      }

      UIMessageService.confirmedExecution(
          function () {
            $timeout(function () {
              UIUtilService.setDirty(false);
              UIUtilService.setValidation(true);
              vm.returnToWorkspace();
            });
          },
          'GENERIC.AreYouSure',
          'DASHBOARD.back',
          'GENERIC.YesGoBack'
      );
    };

    vm.returnToWorkspace = function () {
      vm.allowUnload = true;
      UIUtilService.activeLocator = null;
      UIUtilService.activeZeroLocator = null;
      $window.location.assign(FrontendUrlService.getWorkspaceReturn(
          QueryParamUtilsService.getReturnTo(), QueryParamUtilsService.getFolderId()));
    };

    vm.formatDocumentTitle = function () {
      return UIUtilService.formatTitleString($rootScope.documentTitle);
    };

    vm.formatDocumentTitleFull = function () {
      return UIUtilService.formatTitleStringFull($rootScope.documentTitle);
    };

    vm.getResourceType = function () {
      var routeRoot = vm.path.split('/')[1];
      if (routeRoot === 'templates') {
        return 'template';
      }
      if (routeRoot === 'elements') {
        return 'element';
      }
      if (routeRoot === 'fields') {
        return 'field';
      }
    };

    $rootScope.$on('$locationChangeStart', function (event) {
      var openModal = jQuery('.modal.fade.in');
      if ((openModal.data('bs.modal') || {}).isShown === true) {
        openModal.modal('hide');
        event.preventDefault();
      }
    });

    $rootScope.$on('$locationChangeSuccess', function () {
      vm.path = $location.path();
      vm.resourceType = vm.getResourceType();
      $rootScope.setHeader();
      $document.unbind('keypress');
      $document.unbind('keyup');
    });
  }
});
