'use strict';

define([
  'angular',
  'angularMocks',
  'cedar/template-editor/service/http-builder.service',
  'cedar/template-editor/service/template.service',
  'cedar/template-editor/service/template-element.service',
  'cedar/template-editor/service/template-field.service'
], function () {

  describe('Designer artifact update validators:', function () {
    beforeEach(module('cedar.templateEditor.service.httpBuilderService'));
    beforeEach(module('cedar.templateEditor.service.templateService'));
    beforeEach(module('cedar.templateEditor.service.templateElementService'));
    beforeEach(module('cedar.templateEditor.service.templateFieldService', function ($provide) {
      $provide.value('UrlService', {
        getTemplate: function () { return '/templates/one'; },
        getTemplateElement: function () { return '/elements/one'; },
        getTemplateField: function () { return '/fields/one'; }
      });
    }));

    it('uses the live template model as validator owner while sending a sanitized copy',
        inject(function (TemplateService) {
          var live = {'@id': 'one', $$cedarEtag: '"3"'};
          var copy = {'@id': 'one', 'schema:name': 'Updated'};
          var request = TemplateService.updateTemplate('one', copy, live);
          expect(request.cedarArtifact).toBe(live);
          expect(JSON.parse(request.data)['schema:name']).toBe('Updated');
        }));

    it('does the same for elements and fields',
        inject(function (TemplateElementService, TemplateFieldService) {
          var liveElement = {'@id': 'one', $$cedarEtag: '"4"'};
          var liveField = {'@id': 'one', $$cedarEtag: '"5"'};
          expect(TemplateElementService.updateTemplateElement('one', {}, liveElement).cedarArtifact)
              .toBe(liveElement);
          expect(TemplateFieldService.updateTemplateField('one', {}, liveField).cedarArtifact)
              .toBe(liveField);
        }));
  });
});
