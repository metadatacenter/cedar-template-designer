/*jslint node: true */
/*global define */
'use strict';

define([
  // angular modules
  'angular',
  'lib/angular-animate/angular-animate.min',
  'lib/angular-bootstrap/ui-bootstrap-tpls.min',
  'lib/ng-tags-input/ng-tags-input.min',
  'lib/angular-route/angular-route.min',
  'lib/angular-sanitize/angular-sanitize.min',
  'lib/angular-ui-select/dist/select.min',
  'lib/angular-ui-sortable/sortable.min',
  'lib/angular-ui-switch/angular-ui-switch.min',
  'lib/angular-translate/angular-translate.min',
  'lib/angular-translate-loader-static-files/angular-translate-loader-static-files.min',
  'lib/angular-toasty/dist/angular-toasty.min',

  // non-angular 3rd party libraries
  'lib/bootstrap/dist/js/bootstrap.min',
  'lib/bootstrap-select/dist/js/bootstrap-select.min',
  'lib/ng-ckeditor/ng-ckeditor.min',
  'ckeditor',
  'jquery',
  'lib/jquery-ui/jquery-ui.min',
  'lib/sweetalert/dist/sweetalert.min',
  'lib/angulartics/dist/angulartics.min',
  'lib/angulartics-google-analytics/dist/angulartics-google-analytics.min',
  'jsonld',

  // custom libraries

  // CEDAR Template Designer modules
  'cedar/template-editor/core/core.module',
  'cedar/template-editor/layout/layout.module',
  'cedar/template-editor/service/service.module',
  'cedar/template-editor/template/template.module',
  'cedar/template-editor/template-element/template-element.module',
  'cedar/template-editor/template-field/template-field.module'
], function (angular) {
  // angular-translate 2.8 still calls this helper, which AngularJS 1.7 removed.
  angular.lowercase = function (text) {
    return text.toLowerCase();
  };

  return angular.module('cedar.templateDesigner', [
    'ui.bootstrap',
    'ngRoute',
    'ngAnimate',
    'ngSanitize',
    'ui.select',
    'ui.sortable',
    'pascalprecht.translate',
    'angular-toasty',
    'ngCkeditor',
    'angulartics',
    'angulartics.google.analytics',

    'cedar.templateEditor.core',
    'cedar.templateEditor.layout',
    'cedar.templateEditor.service',
    'cedar.templateEditor.template',
    'cedar.templateEditor.templateElement',
    'cedar.templateEditor.templateField',
  ])
      .config(['$httpProvider', function ($httpProvider) {
        // Cache-bust our own .html template partials the same way the JS and
        // JSON resources already are (window.cedarCacheControl comes from
        // config/version.js, which nginx serves no-store). Without this, a new
        // release could still serve a stale template from the browser cache.
        // Scoped to scripts/*.html on purpose: 3rd-party libs (ui-bootstrap,
        // ui-switch, ...) pre-populate $templateCache under bare keys, so
        // appending ?v= to those would miss the cache and 404.
        $httpProvider.interceptors.push(function () {
          return {
            request: function (config) {
              if (config.url && /^scripts\/.*\.html$/.test(config.url)) {
                config.url += (config.url.indexOf('?') === -1 ? '?' : '&') +
                  'v=' + window.cedarCacheControl;
              }
              return config;
            }
          };
        });
      }]);
});
